import type { IncomingMessage } from "node:http";

import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import {
  toNodeHandler,
  type NodeIncomingMessageLike,
  type NodeServerResponseLike,
} from "@modelcontextprotocol/node";
import type { AuthInfo } from "@modelcontextprotocol/server";

import type { AgentMeshDatabase } from "./db/client.js";
import { registerAdminRoutes } from "./admin/routes.js";
import type { AdminRouteDependencies } from "./admin/routes.js";
import fastifyCookie from "@fastify/cookie";
import { AgentMeshError } from "./errors.js";
import { createSafeLogger } from "./logging.js";
import type { SafeLogger } from "./logging.js";
import { buildMcpHandler } from "./mcp/server.js";
import type { ProjectService } from "./projects/service.js";
import { registerWebAuthRoutes } from "./web-auth/routes.js";
import type { WebAuthRouteDependencies } from "./web-auth/routes.js";

interface HttpAppDependencies {
  db: AgentMeshDatabase;
  signingKey: Buffer;
  projectService: Pick<ProjectService, "authenticateProject">;
  host: string;
  allowedHosts: string[];
  admin: AdminRouteDependencies | null;
  web?: WebAuthRouteDependencies | null;
  logger?: SafeLogger;
}

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

function bearerFromHeader(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

export function buildHttpApp(dependencies: HttpAppDependencies) {
  const logger = dependencies.logger ?? createSafeLogger();
  const app = createMcpFastifyApp({
    host: dependencies.host,
    allowedHosts: dependencies.allowedHosts,
    allowedOrigins: dependencies.allowedHosts,
  });
  const mcpHandler = buildMcpHandler({
    db: dependencies.db,
    signingKey: dependencies.signingKey,
    logger,
  });
  const nodeHandler = toNodeHandler(mcpHandler);

  app.get("/health", async () => ({ status: "ok" }));

  registerAdminRoutes(app, dependencies.admin);
  if (dependencies.web !== undefined && dependencies.web !== null) {
    app.register(fastifyCookie);
    registerWebAuthRoutes(app, dependencies.web);
  }

  app.post("/mcp", async (request, reply) => {
    const bearer = bearerFromHeader(request.headers.authorization);
    if (bearer === null) {
      logger.write({ event: "http.request_failed" });
      return reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "unauthorized" });
    }

    let projectId: string;
    try {
      projectId = await dependencies.projectService.authenticateProject(bearer);
    } catch (error) {
      if (error instanceof AgentMeshError && error.code === "PROJECT_AUTH_INVALID") {
        logger.write({ event: "http.request_failed" });
        return reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "unauthorized" });
      }
      logger.write({ event: "http.request_failed", error_code: "INTERNAL_ERROR" });
      return reply.code(500).send({ error: "internal_error" });
    }

    (request.raw as AuthenticatedIncomingMessage).auth = {
      token: "validated-project-token",
      clientId: projectId,
      scopes: ["agentmesh"],
    };
    reply.hijack();
    await nodeHandler(
      request.raw as unknown as NodeIncomingMessageLike,
      reply.raw as unknown as NodeServerResponseLike,
      request.body,
    );
  });

  app.addHook("onClose", async () => {
    await mcpHandler.close();
  });

  return app;
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { adminListQuerySchema } from "../admin/contracts.js";
import { sendInvalidPayloadError, sendWebHttpError } from "../http-errors.js";
import { createWebAuthMiddleware } from "../web-auth/middleware.js";
import {
  operatorUserPathSchema,
  projectPathSchema,
} from "./contracts.js";
import {
  createOperatorService,
  OperatorControlError,
} from "./operator-service.js";
import type { ControlRouteDependencies } from "./routes.js";

const NO_STORE = "no-store";

function cookieName(secureCookies: boolean): string {
  return secureCookies ? "__Host-agentmesh_session" : "agentmesh_session";
}

function emptyQuery(query: unknown): boolean {
  return query !== null && typeof query === "object" && !Array.isArray(query)
    && Object.keys(query).length === 0;
}

function parseListQuery(query: unknown) {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return null;
  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if ((key !== "limit" && key !== "cursor") || typeof value !== "string" || value.length > 684) {
      return null;
    }
    if (key === "limit") {
      if (!/^[1-9][0-9]{0,2}$/.test(value)) return null;
      values.limit = Number(value);
    } else {
      values.cursor = value;
    }
  }
  const parsed = adminListQuerySchema.safeParse(values);
  return parsed.success ? parsed.data : null;
}

function invalidRequest(request: FastifyRequest, reply: FastifyReply) {
  return sendWebHttpError(request, reply, 400, "INVALID_REQUEST");
}

function operatorFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (!(error instanceof OperatorControlError)) {
    return sendWebHttpError(request, reply, 503, "CONTROL_UNAVAILABLE");
  }
  switch (error.code) {
    case "INVALID_REQUEST":
      return sendWebHttpError(request, reply, 400, error.code);
    case "USER_NOT_FOUND":
    case "PROJECT_NOT_FOUND":
      return sendWebHttpError(request, reply, 404, error.code);
    case "USER_BLOCKED":
    case "USER_STATE_CONFLICT":
    case "PROJECT_STATE_CONFLICT":
    case "PROJECT_LIMIT_REACHED":
      return sendWebHttpError(request, reply, 409, error.code);
    case "CONTROL_UNAVAILABLE":
      return sendWebHttpError(request, reply, 503, error.code);
  }
}

export function registerOperatorRoutes(
  app: FastifyInstance,
  dependencies: ControlRouteDependencies,
): void {
  const middleware = createWebAuthMiddleware({
    sessionCookieName: cookieName(dependencies.config.secureCookies),
    publicOrigin: dependencies.config.publicOrigin,
    operatorGitHubIds: dependencies.config.operatorGitHubIds,
    sessionService: dependencies.sessionService,
  });
  middleware.register(app);
  const service = createOperatorService({
    db: dependencies.db,
    audit: dependencies.auditService,
    projectLimit: dependencies.config.projectLimit,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });

  app.addHook("onRequest", (request, reply, done) => {
    const pathname = request.url.split("?", 1)[0] ?? "";
    if (pathname === "/api/v1/ops" || pathname.startsWith("/api/v1/ops/")) {
      reply.header("Cache-Control", NO_STORE);
    }
    done();
  });
  const readOptions = {
    preHandler: dependencies.rateLimits === undefined
      ? middleware.requireOperator
      : [middleware.requireOperator, dependencies.rateLimits.ownerRead],
    errorHandler: sendInvalidPayloadError,
  };
  const mutationOptions = {
    preHandler: dependencies.rateLimits === undefined
      ? [middleware.requireMutation, middleware.requireOperator]
      : [
          middleware.requireMutation,
          middleware.requireOperator,
          dependencies.rateLimits.ownerMutation,
        ],
    errorHandler: sendInvalidPayloadError,
    bodyLimit: 4_096,
  };

  app.get("/api/v1/ops/users", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const query = parseListQuery(request.query);
    if (query === null) return invalidRequest(request, reply);
    try {
      return reply.send(await service.listUsers(query));
    } catch (error) {
      return operatorFailure(error, request, reply);
    }
  });

  app.get("/api/v1/ops/projects", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const query = parseListQuery(request.query);
    if (query === null) return invalidRequest(request, reply);
    try {
      return reply.send(await service.listProjects(query));
    } catch (error) {
      return operatorFailure(error, request, reply);
    }
  });

  app.get("/api/v1/ops/users/:userId", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const path = operatorUserPathSchema.safeParse(request.params);
    if (!path.success || !emptyQuery(request.query)) return invalidRequest(request, reply);
    try {
      const user = await service.getUser(path.data.userId);
      return user.found
        ? reply.send({ user: user.data })
        : sendWebHttpError(request, reply, 404, "USER_NOT_FOUND");
    } catch (error) {
      return operatorFailure(error, request, reply);
    }
  });

  app.get("/api/v1/ops/projects/:projectId", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const path = projectPathSchema.safeParse(request.params);
    if (!path.success || !emptyQuery(request.query)) return invalidRequest(request, reply);
    try {
      const project = await service.getProject(path.data.projectId);
      return project.found
        ? reply.send({ project: project.data })
        : sendWebHttpError(request, reply, 404, "PROJECT_NOT_FOUND");
    } catch (error) {
      return operatorFailure(error, request, reply);
    }
  });

  const userMutation = (operation: "blockUser" | "unblockUser") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.webSession === null) return;
      const path = operatorUserPathSchema.safeParse(request.params);
      if (!path.success || !emptyQuery(request.query) || request.body !== undefined) {
        return invalidRequest(request, reply);
      }
      try {
        const user = await service[operation]({
          operatorUserId: request.webSession.userId,
          targetUserId: path.data.userId,
          requestId: request.id,
        });
        return reply.send({ user });
      } catch (error) {
        return operatorFailure(error, request, reply);
      }
    };

  app.post("/api/v1/ops/users/:userId/block", mutationOptions, userMutation("blockUser"));
  app.post("/api/v1/ops/users/:userId/unblock", mutationOptions, userMutation("unblockUser"));

  app.post("/api/v1/ops/projects/:projectId/archive", mutationOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const path = projectPathSchema.safeParse(request.params);
    if (!path.success || !emptyQuery(request.query) || request.body !== undefined) {
      return invalidRequest(request, reply);
    }
    try {
      const project = await service.archiveProject({
        operatorUserId: request.webSession.userId,
        projectId: path.data.projectId,
        requestId: request.id,
      });
      return reply.send({ project });
    } catch (error) {
      return operatorFailure(error, request, reply);
    }
  });
}

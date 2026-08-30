import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";

import { uuidV4Schema } from "../contracts.js";
import {
  clearSessionCookie,
  parseAdminCookie,
  type AdminAuth,
} from "./auth.js";
import {
  adminListQuerySchema,
  eventListQuerySchema,
  messageListQuerySchema,
} from "./contracts.js";
import type { AdminQueryService } from "./query-service.js";
import { renderAdminPage } from "./ui/page.js";

export interface AdminRouteDependencies {
  auth: AdminAuth;
  queryService: AdminQueryService;
}

const noStore = "no-store";

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ error: "invalid_request" });
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ error: "unauthorized" });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "not_found" });
}

function temporarilyUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: "temporarily_unavailable" });
}

function adminPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? "";
  return pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/");
}

function parseQuery(query: unknown, options: { booleans?: readonly string[]; numbers?: readonly string[]; strings: readonly string[] }): Record<string, string | number | boolean> | null {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return null;
  }
  const booleans = new Set(options.booleans);
  const numbers = new Set(options.numbers);
  const allowed = new Set([...options.strings, ...booleans, ...numbers]);
  const parsed: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== "string") {
      return null;
    }
    if (numbers.has(key)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
        return null;
      }
      parsed[key] = Number(value);
    } else if (booleans.has(key)) {
      if (value !== "true" && value !== "false") {
        return null;
      }
      parsed[key] = value === "true";
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function parsePathId(value: string | undefined): string | null {
  const parsed = uuidV4Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseLogin(body: unknown): string | null {
  const parsed = z.object({ token: z.string() }).strict().safeParse(body);
  return parsed.success ? parsed.data.token : null;
}

function adminErrorHandler(_error: Error, _request: FastifyRequest, reply: FastifyReply): void {
  void invalidRequest(reply);
}

function registerAdminNotFoundHandler(app: FastifyInstance, prefix: string): void {
  app.register((adminApp, _options, done) => {
    adminApp.addHook("onRequest", (_request, reply, next) => {
      reply.header("Cache-Control", noStore);
      next();
    });
    adminApp.setNotFoundHandler((_request, reply) => notFound(reply));
    done();
  }, { prefix });
}

export function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteDependencies | null,
): void {
  registerAdminNotFoundHandler(app, "/admin");
  registerAdminNotFoundHandler(app, "/api/admin");

  if (dependencies === null) {
    return;
  }

  app.addHook("onRequest", (request, reply, done) => {
    if (adminPath(request.url)) {
      reply.header("Cache-Control", noStore);
    }
    done();
  });

  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const session = parseAdminCookie(request.headers.cookie);
    if (session === null || !dependencies.auth.verifySession(session)) {
      return unauthorized(reply);
    }
    return undefined;
  };
  const apiOptions = {
    preHandler: requireSession,
    errorHandler: adminErrorHandler,
    exposeHeadRoute: false,
  };

  app.get("/admin", { errorHandler: adminErrorHandler }, async (request, reply) => {
    const session = parseAdminCookie(request.headers.cookie);
    const page = renderAdminPage({
      authenticated: session !== null && dependencies.auth.verifySession(session),
      nonce: randomBytes(16).toString("base64"),
    });
    return reply
      .header("Content-Security-Policy", page.contentSecurityPolicy)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .type("text/html; charset=utf-8")
      .send(page.body);
  });

  app.post("/admin/session", { errorHandler: adminErrorHandler }, async (request, reply) => {
    const token = parseLogin(request.body);
    if (token === null) {
      return invalidRequest(reply);
    }
    if (!dependencies.auth.verifyLogin(token)) {
      return unauthorized(reply);
    }
    return reply.header("Set-Cookie", dependencies.auth.issueSession().cookie).code(204).send();
  });

  app.delete("/admin/session", { errorHandler: adminErrorHandler }, async (_request, reply) => {
    return reply.header("Set-Cookie", clearSessionCookie(false)).code(204).send();
  });

  app.get("/api/admin/projects", apiOptions, async (request, reply) => {
    const query = parseQuery(request.query, { strings: ["cursor"], numbers: ["limit"] });
    const parsed = query === null ? null : adminListQuerySchema.safeParse(query);
    if (parsed === null || !parsed.success) {
      return invalidRequest(reply);
    }
    try {
      return reply.send(await dependencies.queryService.listProjects(parsed.data));
    } catch {
      return temporarilyUnavailable(reply);
    }
  });

  app.get("/api/admin/projects/:projectId/summary", apiOptions, async (request, reply) => {
    const projectId = parsePathId((request.params as { projectId?: string }).projectId);
    const query = parseQuery(request.query, { strings: [] });
    if (projectId === null || query === null) {
      return invalidRequest(reply);
    }
    try {
      const result = await dependencies.queryService.getSummary(projectId);
      return result.found ? reply.send(result.data) : notFound(reply);
    } catch {
      return temporarilyUnavailable(reply);
    }
  });

  app.get("/api/admin/projects/:projectId/agents", apiOptions, async (request, reply) => {
    const projectId = parsePathId((request.params as { projectId?: string }).projectId);
    const query = parseQuery(request.query, { strings: ["cursor"], numbers: ["limit"] });
    const parsed = query === null ? null : adminListQuerySchema.safeParse(query);
    if (projectId === null || parsed === null || !parsed.success) {
      return invalidRequest(reply);
    }
    try {
      const result = await dependencies.queryService.listAgents(projectId, parsed.data);
      return result.found ? reply.send(result.data) : notFound(reply);
    } catch {
      return temporarilyUnavailable(reply);
    }
  });

  app.get("/api/admin/projects/:projectId/messages", apiOptions, async (request, reply) => {
    const projectId = parsePathId((request.params as { projectId?: string }).projectId);
    const query = parseQuery(request.query, {
      strings: ["agent_id", "cursor", "after"],
      booleans: ["acknowledged"],
      numbers: ["limit"],
    });
    const parsed = query === null ? null : messageListQuerySchema.safeParse(query);
    if (projectId === null || parsed === null || !parsed.success) {
      return invalidRequest(reply);
    }
    try {
      const result = await dependencies.queryService.listMessages(projectId, parsed.data);
      return result.found ? reply.send(result.data) : notFound(reply);
    } catch {
      return temporarilyUnavailable(reply);
    }
  });

  app.get("/api/admin/projects/:projectId/messages/:messageId", apiOptions, async (request, reply) => {
    const parameters = request.params as { projectId?: string; messageId?: string };
    const projectId = parsePathId(parameters.projectId);
    const messageId = parsePathId(parameters.messageId);
    const query = parseQuery(request.query, { strings: [] });
    if (projectId === null || messageId === null || query === null) {
      return invalidRequest(reply);
    }
    try {
      const result = await dependencies.queryService.getMessage(projectId, messageId);
      return result.found ? reply.send(result.data) : notFound(reply);
    } catch {
      return temporarilyUnavailable(reply);
    }
  });

  app.get("/api/admin/projects/:projectId/events", apiOptions, async (request, reply) => {
    const projectId = parsePathId((request.params as { projectId?: string }).projectId);
    const query = parseQuery(request.query, {
      strings: ["agent_id", "event_type", "outcome", "cursor", "after"],
      numbers: ["limit"],
    });
    const parsed = query === null ? null : eventListQuerySchema.safeParse(query);
    if (projectId === null || parsed === null || !parsed.success) {
      return invalidRequest(reply);
    }
    try {
      const result = await dependencies.queryService.listEvents(projectId, parsed.data);
      return result.found ? reply.send(result.data) : notFound(reply);
    } catch {
      return temporarilyUnavailable(reply);
    }
  });
}

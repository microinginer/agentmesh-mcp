import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuditService } from "../audit/service.js";
import type { WebAuthConfig } from "../config.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { sendWebHttpError } from "../http-errors.js";
import { createWebAuthMiddleware } from "../web-auth/middleware.js";
import type { WebSessionService } from "../web-auth/session-service.js";
import {
  createProjectBodySchema,
  deleteProjectBodySchema,
  projectIdempotencyKeySchema,
  projectListQuerySchema,
  projectPathSchema,
} from "./contracts.js";
import {
  ControlProjectError,
  createControlProjectService,
  type PublicControlProject,
} from "./project-service.js";

const NO_STORE = "no-store";
const MAX_IDEMPOTENCY_HEADER_LENGTH = 64;

export interface ControlRouteDependencies {
  db: AgentMeshDatabase;
  config: WebAuthConfig;
  sessionService: WebSessionService;
  auditService: AuditService;
  clock?: () => Date;
}

function cookieNames(secureCookies: boolean) {
  return secureCookies ? "__Host-agentmesh_session" : "agentmesh_session";
}

function publicProject(project: PublicControlProject) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    archived_at: project.archivedAt,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

function singleRawHeader(request: FastifyRequest, name: string, maximumLength: number): string | null {
  const rawHeaders = request.raw.rawHeaders;
  if (Array.isArray(rawHeaders) && rawHeaders.length > 0) {
    let selected: string | null = null;
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() !== name) continue;
      const value = rawHeaders[index + 1];
      if (selected !== null || value === undefined || value.length === 0 || value.length > maximumLength) {
        return null;
      }
      selected = value;
    }
    return selected;
  }
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength ? value : null;
}

function parseListQuery(query: unknown): { limit: number } | null {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return null;
  const entries = Object.entries(query);
  if (entries.length === 0) return projectListQuerySchema.parse({});
  if (entries.length !== 1 || entries[0]?.[0] !== "limit") return null;
  const value = entries[0]?.[1];
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value)) return null;
  const parsed = projectListQuerySchema.safeParse({ limit: Number(value) });
  return parsed.success ? parsed.data : null;
}

function emptyQuery(query: unknown): boolean {
  return query !== null && typeof query === "object" && !Array.isArray(query) && Object.keys(query).length === 0;
}

function parsePath(request: FastifyRequest): string | null {
  const parsed = projectPathSchema.safeParse(request.params);
  return parsed.success ? parsed.data.projectId : null;
}

function invalidRequest(request: FastifyRequest, reply: FastifyReply) {
  return sendWebHttpError(request, reply, 400, "INVALID_REQUEST");
}

function controlFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (!(error instanceof ControlProjectError)) {
    return sendWebHttpError(request, reply, 503, "CONTROL_UNAVAILABLE");
  }
  switch (error.code) {
    case "PROJECT_NOT_FOUND":
      return sendWebHttpError(request, reply, 404, error.code);
    case "PROJECT_LIMIT_REACHED":
    case "PROJECT_STATE_CONFLICT":
    case "PROJECT_CONFIRMATION_MISMATCH":
      return sendWebHttpError(request, reply, 409, error.code);
    case "RECENT_AUTH_REQUIRED":
      return sendWebHttpError(request, reply, 403, error.code);
    case "CONTROL_UNAVAILABLE":
      return sendWebHttpError(request, reply, 503, error.code);
  }
}

export function registerControlRoutes(app: FastifyInstance, dependencies: ControlRouteDependencies): void {
  const middleware = createWebAuthMiddleware({
    sessionCookieName: cookieNames(dependencies.config.secureCookies),
    publicOrigin: dependencies.config.publicOrigin,
    operatorGitHubIds: dependencies.config.operatorGitHubIds,
    sessionService: dependencies.sessionService,
  });
  middleware.register(app);
  const service = createControlProjectService({
    db: dependencies.db,
    audit: dependencies.auditService,
    projectLimit: dependencies.config.projectLimit,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const noStore = (_request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    reply.header("Cache-Control", NO_STORE);
    done();
  };
  const invalidPayload = (_error: Error, request: FastifyRequest, reply: FastifyReply) => {
    void invalidRequest(request, reply);
  };
  const readOptions = {
    onRequest: noStore,
    preHandler: middleware.requireSession,
    errorHandler: invalidPayload,
  };
  const mutationOptions = {
    onRequest: noStore,
    preHandler: middleware.requireMutation,
    errorHandler: invalidPayload,
    bodyLimit: 4_096,
  };

  app.get("/api/v1/projects", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const query = parseListQuery(request.query);
    if (query === null) return invalidRequest(request, reply);
    try {
      const result = await service.list({ ownerUserId: request.webSession.userId, limit: query.limit });
      return reply.send({
        projects: result.projects.map(publicProject),
        active_count: result.activeCount,
        project_limit: result.projectLimit,
      });
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.post("/api/v1/projects", mutationOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const body = createProjectBodySchema.safeParse(request.body);
    const idempotencyKey = singleRawHeader(request, "idempotency-key", MAX_IDEMPOTENCY_HEADER_LENGTH);
    const parsedKey = projectIdempotencyKeySchema.safeParse(idempotencyKey);
    if (!body.success || !parsedKey.success || !emptyQuery(request.query)) {
      return invalidRequest(request, reply);
    }
    try {
      const project = await service.create({
        ownerUserId: request.webSession.userId,
        name: body.data.name,
        description: body.data.description,
        idempotencyKey: parsedKey.data,
        requestId: request.id,
      });
      return reply.code(201).send({ project: publicProject(project) });
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.get("/api/v1/projects/:projectId", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    if (projectId === null || !emptyQuery(request.query)) return invalidRequest(request, reply);
    try {
      const project = await service.get({ ownerUserId: request.webSession.userId, projectId });
      return project === null
        ? sendWebHttpError(request, reply, 404, "PROJECT_NOT_FOUND")
        : reply.send({ project: publicProject(project) });
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  const lifecycleMutation = (operation: "archive" | "restore") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.webSession === null) return;
      const projectId = parsePath(request);
      if (projectId === null || !emptyQuery(request.query) || request.body !== undefined) {
        return invalidRequest(request, reply);
      }
      try {
        const project = await service[operation]({
          ownerUserId: request.webSession.userId,
          projectId,
          requestId: request.id,
        });
        return reply.send({ project: publicProject(project) });
      } catch (error) {
        return controlFailure(error, request, reply);
      }
    };

  app.post("/api/v1/projects/:projectId/archive", mutationOptions, lifecycleMutation("archive"));
  app.post("/api/v1/projects/:projectId/restore", mutationOptions, lifecycleMutation("restore"));

  app.delete("/api/v1/projects/:projectId", mutationOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    const body = deleteProjectBodySchema.safeParse(request.body);
    if (projectId === null || !body.success || !emptyQuery(request.query)) {
      return invalidRequest(request, reply);
    }
    try {
      await service.delete({
        ownerUserId: request.webSession.userId,
        projectId,
        confirmName: body.data.confirm_name,
        authenticatedAt: request.webSession.authenticatedAt,
        requestId: request.id,
      });
      return reply.code(204).send();
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuditService } from "../audit/service.js";
import type { WebAuthConfig } from "../config.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { sendWebHttpError } from "../http-errors.js";
import { createWebAuthMiddleware } from "../web-auth/middleware.js";
import type { WebSessionService } from "../web-auth/session-service.js";
import {
  connectionListQuerySchema,
  connectionPathSchema,
  createConnectionBodySchema,
  createProjectBodySchema,
  deleteProjectBodySchema,
  projectIdempotencyKeySchema,
  projectListQuerySchema,
  projectPathSchema,
} from "./contracts.js";
import {
  ConnectionControlError,
  createConnectionService,
  type IssuedControlConnection,
  type PublicControlConnection,
} from "./connection-service.js";
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

function publicConnection(connection: PublicControlConnection | IssuedControlConnection) {
  return {
    id: "id" in connection ? connection.id : connection.connectionId,
    label: connection.label,
    status: connection.status,
    expires_at: connection.expiresAt,
    last_used_at: connection.lastUsedAt,
    revoked_at: connection.revokedAt,
    created_at: connection.createdAt,
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

function parseConnectionPath(request: FastifyRequest): { projectId: string; connectionId: string } | null {
  const parsed = connectionPathSchema.safeParse(request.params);
  return parsed.success ? parsed.data : null;
}

function invalidRequest(request: FastifyRequest, reply: FastifyReply) {
  return sendWebHttpError(request, reply, 400, "INVALID_REQUEST");
}

function controlFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (!(error instanceof ControlProjectError) && !(error instanceof ConnectionControlError)) {
    return sendWebHttpError(request, reply, 503, "CONTROL_UNAVAILABLE");
  }
  switch (error.code) {
    case "INVALID_REQUEST":
      return sendWebHttpError(request, reply, 400, error.code);
    case "PROJECT_NOT_FOUND":
    case "CONNECTION_NOT_FOUND":
      return sendWebHttpError(request, reply, 404, error.code);
    case "PROJECT_LIMIT_REACHED":
    case "PROJECT_STATE_CONFLICT":
    case "PROJECT_CONFIRMATION_MISMATCH":
    case "CONNECTION_STATE_CONFLICT":
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
  const projectService = createControlProjectService({
    db: dependencies.db,
    audit: dependencies.auditService,
    projectLimit: dependencies.config.projectLimit,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const connectionService = createConnectionService({
    db: dependencies.db,
    audit: dependencies.auditService,
    tokenTtlDays: dependencies.config.tokenTtlDays,
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
      const result = await projectService.list({ ownerUserId: request.webSession.userId, limit: query.limit });
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
      const project = await projectService.create({
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
      const project = await projectService.get({ ownerUserId: request.webSession.userId, projectId });
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
        const project = await projectService[operation]({
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

  app.get("/api/v1/projects/:projectId/connections", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    const query = parseListQuery(request.query);
    if (projectId === null || query === null) return invalidRequest(request, reply);
    try {
      const connections = await connectionService.list({
        ownerUserId: request.webSession.userId,
        projectId,
        limit: connectionListQuerySchema.parse(query).limit,
      });
      return reply.send({ connections: connections.map(publicConnection) });
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.post("/api/v1/projects/:projectId/connections", mutationOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    const body = createConnectionBodySchema.safeParse(request.body);
    const idempotencyKey = singleRawHeader(request, "idempotency-key", MAX_IDEMPOTENCY_HEADER_LENGTH);
    const parsedKey = projectIdempotencyKeySchema.safeParse(idempotencyKey);
    if (projectId === null || !body.success || !parsedKey.success || !emptyQuery(request.query)) {
      return invalidRequest(request, reply);
    }
    try {
      const issued = await connectionService.issue({
        ownerUserId: request.webSession.userId,
        projectId,
        label: body.data.label,
        idempotencyKey: parsedKey.data,
        requestId: request.id,
      });
      return reply.code(201).send({
        connection: publicConnection(issued),
        secret: issued.secret,
        secret_recoverable: issued.secretRecoverable,
      });
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.post(
    "/api/v1/projects/:projectId/connections/:connectionId/revoke",
    mutationOptions,
    async (request, reply) => {
      if (request.webSession === null) return;
      const path = parseConnectionPath(request);
      if (path === null || !emptyQuery(request.query) || request.body !== undefined) {
        return invalidRequest(request, reply);
      }
      try {
        const connection = await connectionService.revoke({
          ownerUserId: request.webSession.userId,
          projectId: path.projectId,
          connectionId: path.connectionId,
          requestId: request.id,
        });
        return reply.send({ connection: publicConnection(connection) });
      } catch (error) {
        return controlFailure(error, request, reply);
      }
    },
  );

  app.delete("/api/v1/projects/:projectId", mutationOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    const body = deleteProjectBodySchema.safeParse(request.body);
    if (projectId === null || !body.success || !emptyQuery(request.query)) {
      return invalidRequest(request, reply);
    }
    try {
      await projectService.delete({
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

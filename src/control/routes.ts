import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuditService } from "../audit/service.js";
import {
  adminListQuerySchema,
  eventListQuerySchema,
  messageListQuerySchema,
} from "../admin/contracts.js";
import type { WebAuthConfig } from "../config.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { sendInvalidPayloadError, sendWebHttpError } from "../http-errors.js";
import type { WebRouteRateLimits } from "../rate-limits.js";
import { createPulseService } from "../pulse/service.js";
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
  projectMessagePathSchema,
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
import {
  createProjectReadService,
  ProjectReadUnavailableError,
} from "./read-service.js";

const NO_STORE = "no-store";
const MAX_IDEMPOTENCY_HEADER_LENGTH = 64;

export interface ControlRouteDependencies {
  db: AgentMeshDatabase;
  config: WebAuthConfig;
  sessionService: WebSessionService;
  auditService: AuditService;
  rateLimits?: WebRouteRateLimits;
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

function parseProjectListQuery(query: unknown): { limit: number; cursor?: string } | null {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return null;
  const entries = Object.entries(query);
  if (entries.length === 0) return { limit: projectListQuerySchema.parse({}).limit };
  const raw = Object.fromEntries(entries.map(([key, value]) => [
    key,
    key === "limit" && typeof value === "string" && /^[1-9][0-9]{0,2}$/.test(value)
      ? Number(value)
      : value,
  ]));
  const parsed = projectListQuerySchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    limit: parsed.data.limit,
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
  };
}

function parseListQuery(query: unknown): { limit: number } | null {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return null;
  const entries = Object.entries(query);
  if (entries.length === 0) return connectionListQuerySchema.parse({});
  if (entries.length !== 1 || entries[0]?.[0] !== "limit") return null;
  const value = entries[0]?.[1];
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value)) return null;
  const parsed = connectionListQuerySchema.safeParse({ limit: Number(value) });
  return parsed.success ? parsed.data : null;
}

function emptyQuery(query: unknown): boolean {
  return query !== null && typeof query === "object" && !Array.isArray(query) && Object.keys(query).length === 0;
}

function validUtcDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function parsePath(request: FastifyRequest): string | null {
  const parsed = projectPathSchema.safeParse(request.params);
  return parsed.success ? parsed.data.projectId : null;
}

function parseConnectionPath(request: FastifyRequest): { projectId: string; connectionId: string } | null {
  const parsed = connectionPathSchema.safeParse(request.params);
  return parsed.success ? parsed.data : null;
}

function parseMessagePath(request: FastifyRequest): { projectId: string; messageId: string } | null {
  const parsed = projectMessagePathSchema.safeParse(request.params);
  return parsed.success ? parsed.data : null;
}

function parseReadQuery(
  query: unknown,
  options: {
    booleans?: readonly string[];
    numbers?: readonly string[];
    strings: readonly string[];
  },
): Record<string, string | number | boolean> | null {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return null;
  const booleans = new Set(options.booleans);
  const numbers = new Set(options.numbers);
  const allowed = new Set([...options.strings, ...booleans, ...numbers]);
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== "string" || value.length > 684) return null;
    if (numbers.has(key)) {
      if (!/^[1-9][0-9]{0,2}$/.test(value)) return null;
      result[key] = Number(value);
    } else if (booleans.has(key)) {
      if (value !== "true" && value !== "false") return null;
      result[key] = value === "true";
    } else {
      result[key] = value;
    }
  }
  return result;
}

function invalidRequest(request: FastifyRequest, reply: FastifyReply) {
  return sendWebHttpError(request, reply, 400, "INVALID_REQUEST");
}

function controlFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ProjectReadUnavailableError) {
    return sendWebHttpError(request, reply, 503, "CONTROL_UNAVAILABLE");
  }
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
  const readService = createProjectReadService({
    db: dependencies.db,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const pulseService = createPulseService({
    db: dependencies.db,
    agentService: {
      authenticateAgent: async () => {
        throw new Error("Agent authentication not supported in control read route");
      },
    },
    activity: {
      record: async () => {},
      recordBestEffort: async () => {},
    },
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const noStore = (_request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    reply.header("Cache-Control", NO_STORE);
    done();
  };
  const readOptions = {
    onRequest: noStore,
    preHandler: dependencies.rateLimits === undefined
      ? middleware.requireSession
      : [middleware.requireSession, dependencies.rateLimits.ownerRead],
    errorHandler: sendInvalidPayloadError,
  };
  const mutationOptions = {
    onRequest: noStore,
    preHandler: dependencies.rateLimits === undefined
      ? middleware.requireMutation
      : [middleware.requireMutation, dependencies.rateLimits.ownerMutation],
    errorHandler: sendInvalidPayloadError,
    bodyLimit: 4_096,
  };

  app.get("/api/v1/projects", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const query = parseProjectListQuery(request.query);
    if (query === null) return invalidRequest(request, reply);
    try {
      const result = await projectService.list({
        ownerUserId: request.webSession.userId,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return reply.send({
        projects: result.projects.map(publicProject),
        active_count: result.activeCount,
        project_limit: result.projectLimit,
      });
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.get("/api/v2/projects", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const query = parseProjectListQuery(request.query);
    if (query === null) return invalidRequest(request, reply);
    try {
      const result = await projectService.list({
        ownerUserId: request.webSession.userId,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return reply.send({
        projects: result.projects.map(publicProject),
        active_count: result.activeCount,
        project_limit: result.projectLimit,
        default_project: result.defaultProject === null ? null : publicProject(result.defaultProject),
        next_cursor: result.nextCursor,
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

  app.get("/api/v1/projects/:projectId/overview", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    if (projectId === null || !emptyQuery(request.query)) return invalidRequest(request, reply);
    try {
      const result = await readService.getOverview(
        { kind: "owner", userId: request.webSession.userId },
        projectId,
      );
      return result.found
        ? reply.send({ overview: result.data })
        : sendWebHttpError(request, reply, 404, "PROJECT_NOT_FOUND");
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.get("/api/v1/projects/:projectId/pulse", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    const query = parseReadQuery(request.query, { strings: ["date"] });
    if (
      projectId === null
      || (request.query !== null
        && typeof request.query === "object"
        && Object.keys(request.query).length > 0
        && query === null)
    ) {
      return invalidRequest(request, reply);
    }
    const date = typeof query?.date === "string" ? query.date : undefined;
    if (date !== undefined && !validUtcDateString(date)) return invalidRequest(request, reply);
    try {
      const project = await projectService.get({ ownerUserId: request.webSession.userId, projectId });
      if (project === null) return sendWebHttpError(request, reply, 404, "PROJECT_NOT_FOUND");
      return reply.send(await pulseService.getDailyPulse(projectId, date));
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.get("/api/v1/projects/:projectId/agents", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    const query = parseReadQuery(request.query, { strings: ["cursor"], numbers: ["limit"] });
    const parsed = query === null ? null : adminListQuerySchema.safeParse(query);
    if (projectId === null || parsed === null || !parsed.success) return invalidRequest(request, reply);
    try {
      const result = await readService.listAgents(
        { kind: "owner", userId: request.webSession.userId },
        projectId,
        parsed.data,
      );
      return result.found
        ? reply.send(result.data)
        : sendWebHttpError(request, reply, 404, "PROJECT_NOT_FOUND");
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.get("/api/v1/projects/:projectId/messages", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    const query = parseReadQuery(request.query, {
      strings: ["agent_id", "cursor", "after"],
      booleans: ["acknowledged"],
      numbers: ["limit"],
    });
    const parsed = query === null ? null : messageListQuerySchema.safeParse(query);
    if (projectId === null || parsed === null || !parsed.success) return invalidRequest(request, reply);
    try {
      const result = await readService.listMessages(
        { kind: "owner", userId: request.webSession.userId },
        projectId,
        parsed.data,
      );
      return result.found
        ? reply.send(result.data)
        : sendWebHttpError(request, reply, 404, "PROJECT_NOT_FOUND");
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.get("/api/v1/projects/:projectId/messages/:messageId", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const path = parseMessagePath(request);
    if (path === null || !emptyQuery(request.query)) return invalidRequest(request, reply);
    try {
      const result = await readService.getMessage(
        { kind: "owner", userId: request.webSession.userId },
        path.projectId,
        path.messageId,
      );
      return result.found
        ? reply.send({ message: result.data })
        : sendWebHttpError(request, reply, 404, "PROJECT_NOT_FOUND");
    } catch (error) {
      return controlFailure(error, request, reply);
    }
  });

  app.get("/api/v1/projects/:projectId/events", readOptions, async (request, reply) => {
    if (request.webSession === null) return;
    const projectId = parsePath(request);
    const query = parseReadQuery(request.query, {
      strings: ["agent_id", "event_type", "outcome", "cursor", "after"],
      numbers: ["limit"],
    });
    const parsed = query === null ? null : eventListQuerySchema.safeParse(query);
    if (projectId === null || parsed === null || !parsed.success) return invalidRequest(request, reply);
    try {
      const result = await readService.listEvents(
        { kind: "owner", userId: request.webSession.userId },
        projectId,
        parsed.data,
      );
      return result.found
        ? reply.send(result.data)
        : sendWebHttpError(request, reply, 404, "PROJECT_NOT_FOUND");
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

  const connectionMutationOptions = dependencies.rateLimits === undefined
    ? mutationOptions
    : {
        ...mutationOptions,
        preHandler: [
          middleware.requireMutation,
          dependencies.rateLimits.ownerMutation,
          dependencies.rateLimits.connectionCreate,
        ],
      };

  app.post("/api/v1/projects/:projectId/connections", connectionMutationOptions, async (request, reply) => {
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

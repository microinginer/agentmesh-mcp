import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RateLimitConfig } from "./config.js";

declare module "fastify" {
  interface FastifyRequest {
    rateLimitConnectionId: string | null;
  }
}

export type RateLimitGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface WebRouteRateLimits {
  oauthStart: RateLimitGuard;
  oauthCallback: RateLimitGuard;
  ownerRead: RateLimitGuard;
  ownerMutation: RateLimitGuard;
  connectionCreate: RateLimitGuard;
}

const TEN_MINUTES_MS = 10 * 60 * 1_000;
const ONE_MINUTE_MS = 60 * 1_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;

function opaqueKey(group: string, value: string): string {
  const digest = createHash("sha256")
    .update("agentmesh-rate-limit-v1\0", "utf8")
    .update(group, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
  return `${group}:${digest}`;
}

function byIp(request: FastifyRequest): string {
  return request.ip;
}

function bySession(request: FastifyRequest): string | null {
  return request.webSession?.sessionId ?? null;
}

function byUser(request: FastifyRequest): string | null {
  return request.webSession?.userId ?? null;
}

function byConnection(request: FastifyRequest): string | null {
  return request.rateLimitConnectionId ?? null;
}

function sendRateLimited(request: FastifyRequest, reply: FastifyReply, retryAfter: number): void {
  reply
    .header("Retry-After", Math.max(1, retryAfter))
    .code(429)
    .send({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        request_id: request.id,
      },
    });
}

function createGuard(input: {
  app: FastifyInstance;
  group: string;
  max: number;
  timeWindow: number;
  identity(request: FastifyRequest): string | null;
}): RateLimitGuard {
  const limit = input.app.createRateLimit({
    max: input.max,
    timeWindow: input.timeWindow,
    keyGenerator: (request) => {
      const identity = input.identity(request);
      return opaqueKey(input.group, identity ?? "missing-authenticated-identity");
    },
  });
  return async (request, reply) => {
    if (reply.sent || input.identity(request) === null) return;
    let result: Awaited<ReturnType<typeof limit>>;
    try {
      result = await limit(request);
    } catch {
      reply.code(503).send({
        error: {
          code: "CONTROL_UNAVAILABLE",
          message: "Control plane is temporarily unavailable",
          request_id: request.id,
        },
      });
      return;
    }
    if (!result.isAllowed && result.isExceeded) {
      sendRateLimited(request, reply, result.ttlInSeconds);
    }
  };
}

export function createRateLimitGuards(
  app: FastifyInstance,
  config: RateLimitConfig,
): { web: WebRouteRateLimits; mcp: RateLimitGuard } {
  return {
    web: {
      oauthStart: createGuard({
        app,
        group: "oauth-start",
        max: config.oauthStart,
        timeWindow: TEN_MINUTES_MS,
        identity: byIp,
      }),
      oauthCallback: createGuard({
        app,
        group: "oauth-callback",
        max: config.oauthStart,
        timeWindow: TEN_MINUTES_MS,
        identity: byIp,
      }),
      ownerRead: createGuard({
        app,
        group: "owner-read",
        max: config.ownerRead,
        timeWindow: ONE_MINUTE_MS,
        identity: bySession,
      }),
      ownerMutation: createGuard({
        app,
        group: "owner-mutation",
        max: config.ownerMutation,
        timeWindow: ONE_MINUTE_MS,
        identity: bySession,
      }),
      connectionCreate: createGuard({
        app,
        group: "connection-create",
        max: config.connectionCreate,
        timeWindow: ONE_HOUR_MS,
        identity: byUser,
      }),
    },
    mcp: createGuard({
      app,
      group: "mcp",
      max: config.mcp,
      timeWindow: ONE_MINUTE_MS,
      identity: byConnection,
    }),
  };
}

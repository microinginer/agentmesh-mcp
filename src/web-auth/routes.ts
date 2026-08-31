import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuditService } from "../audit/service.js";
import type { WebAuthConfig } from "../config.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { sendWebHttpError } from "../http-errors.js";
import type { WebRouteRateLimits } from "../rate-limits.js";
import type { GitHubOAuthClient } from "./github-client.js";
import type { IdentityService } from "./identity-service.js";
import { createOAuthService } from "./oauth-service.js";
import { createWebAuthMiddleware } from "./middleware.js";
import { isCanonicalWebCredential, type WebSessionService } from "./session-service.js";
import { deriveWebAuthKeys } from "./session-token.js";

const OAUTH_ATTEMPT_MAX_AGE_SECONDS = 5 * 60;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_COOKIE_HEADER_LENGTH = 8_192;
const MAX_COOKIE_FIELDS = 4;
const MAX_QUERY_LENGTH = 4_096;
const MAX_QUERY_PARTS = 8;
const MAX_QUERY_VALUE_LENGTH = 2_048;
const MAX_CODE_LENGTH = 1_024;
const noStore = "no-store";

export interface WebAuthRouteDependencies {
  db: AgentMeshDatabase;
  config: WebAuthConfig;
  githubClient: GitHubOAuthClient;
  identityService: IdentityService;
  sessionService: WebSessionService;
  auditService: AuditService;
  rateLimits?: WebRouteRateLimits;
  clock?: () => Date;
}

interface CookieNames {
  oauth: string;
  session: string;
}

interface ParsedQuery {
  readonly [key: string]: string;
}

function cookieNames(secureCookies: boolean): CookieNames {
  return secureCookies
    ? { oauth: "__Host-agentmesh_oauth", session: "__Host-agentmesh_session" }
    : { oauth: "agentmesh_oauth", session: "agentmesh_session" };
}

function cookieOptions(secure: boolean, maxAge?: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

interface RawCookieFields {
  fields: string[];
  repeated: boolean;
  invalid: boolean;
}

interface CookieCandidates {
  values: string[];
  invalid: boolean;
}

function rawCookieFields(request: FastifyRequest): RawCookieFields {
  const headers = request.raw.rawHeaders;
  if (Array.isArray(headers) && headers.length > 0) {
    const fields: string[] = [];
    let count = 0;
    let totalLength = 0;
    let invalid = false;
    for (let index = 0; index < headers.length; index += 2) {
      if (headers[index]?.toLowerCase() === "cookie") {
        count += 1;
        const value = headers[index + 1];
        if (value === undefined) {
          invalid = true;
          continue;
        }
        const valueLength = Buffer.byteLength(value, "utf8");
        totalLength += valueLength;
        if (count > MAX_COOKIE_FIELDS || valueLength === 0 || valueLength > MAX_COOKIE_HEADER_LENGTH
          || totalLength > MAX_COOKIE_HEADER_LENGTH) invalid = true;
        fields.push(value);
      }
    }
    return { fields, repeated: count > 1, invalid };
  }
  const value = request.headers.cookie;
  if (value === undefined) return { fields: [], repeated: false, invalid: false };
  if (typeof value !== "string") {
    return { fields: [], repeated: false, invalid: true };
  }
  const valueLength = Buffer.byteLength(value, "utf8");
  return {
    fields: [value],
    repeated: false,
    invalid: valueLength === 0 || valueLength > MAX_COOKIE_HEADER_LENGTH,
  };
}

function cookieCandidates(raw: RawCookieFields, name: string): CookieCandidates {
  const values: string[] = [];
  let invalid = raw.invalid;
  for (const field of raw.fields) {
    for (const item of field.split(";")) {
      const trimmed = item.trim();
      const separator = trimmed.indexOf("=");
      if (separator <= 0 || trimmed.length === 0) {
        invalid = true;
        continue;
      }
      const candidateName = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1);
      if (candidateName.length === 0 || value.length === 0 || hasControlCharacter(candidateName)
        || hasControlCharacter(value)) {
        invalid = true;
        continue;
      }
      if (candidateName === name) {
        values.push(value);
      }
    }
  }
  return { values, invalid };
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function decodeComponent(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return hasControlCharacter(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function rawQuery(url: string): string | null {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return "";
  const query = url.slice(queryIndex + 1);
  if (query.length > MAX_QUERY_LENGTH || query.includes("#")) return null;
  return query;
}

function strictQuery(url: string): ParsedQuery | null {
  const query = rawQuery(url);
  if (query === null) return null;
  if (query === "") return {};
  const items = query.split("&");
  if (items.length > MAX_QUERY_PARTS || items.some((item) => item.length === 0)) return null;
  const result: Record<string, string> = {};
  for (const item of items) {
    const separator = item.indexOf("=");
    if (separator <= 0) return null;
    const key = decodeComponent(item.slice(0, separator));
    const value = decodeComponent(item.slice(separator + 1));
    if (key === null || value === null || key.length === 0 || key.length > 64 || value.length > MAX_QUERY_VALUE_LENGTH
      || Object.hasOwn(result, key)) return null;
    result[key] = value;
  }
  return result;
}

function safeReturnTo(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_QUERY_VALUE_LENGTH
    || /%(?:2[fF]|5[cC]|0[0-9a-fA-F]|1[0-9a-fA-F]|7[fF])/.test(raw)) return "/app";
  let decoded = raw;
  for (let index = 0; index < 4; index += 1) {
    if (/%(?:2[fF]|5[cC]|0[0-9a-fA-F]|1[0-9a-fA-F]|7[fF])/.test(decoded)) return "/app";
    const next = decodeComponent(decoded);
    if (next === null) return "/app";
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes("%") || decoded.length === 0 || decoded.length > MAX_QUERY_VALUE_LENGTH
    || decoded.includes("\\") || !decoded.startsWith("/app")
    || (decoded.length > 4 && !"/?#".includes(decoded[4] ?? ""))) return "/app";
  try {
    const resolved = new URL(decoded, "http://agentmesh.invalid");
    if (resolved.origin !== "http://agentmesh.invalid"
      || (resolved.pathname !== "/app" && !resolved.pathname.startsWith("/app/"))) return "/app";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/app";
  }
}

function startReturnTo(request: FastifyRequest): string {
  const query = rawQuery(request.raw.url ?? "");
  if (query === null || query === "") return "/app";
  const entries = query.split("&");
  if (entries.length > MAX_QUERY_PARTS) return "/app";
  let selected: string | undefined;
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) return "/app";
    const key = decodeComponent(entry.slice(0, separator));
    if (key === null) return "/app";
    if (key === "return_to") {
      if (selected !== undefined) return "/app";
      selected = entry.slice(separator + 1);
    }
  }
  return safeReturnTo(selected);
}

function callbackInput(request: FastifyRequest): { code: string; state: string } | null {
  const query = strictQuery(request.raw.url ?? "");
  if (query === null || Object.keys(query).length !== 2 || typeof query.code !== "string" || typeof query.state !== "string"
    || query.code.length === 0 || query.code.length > MAX_CODE_LENGTH || !isCanonicalWebCredential(query.state)) return null;
  return { code: query.code, state: query.state };
}

function failure(reply: FastifyReply): FastifyReply {
  return reply.code(303).header("location", "/?auth_error=github").send();
}

export function registerWebAuthRoutes(app: FastifyInstance, dependencies: WebAuthRouteDependencies): void {
  const names = cookieNames(dependencies.config.secureCookies);
  const commonCookieOptions = cookieOptions(dependencies.config.secureCookies);
  const middleware = createWebAuthMiddleware({
    sessionCookieName: names.session,
    publicOrigin: dependencies.config.publicOrigin,
    operatorGitHubIds: dependencies.config.operatorGitHubIds,
    sessionService: dependencies.sessionService,
  });
  middleware.register(app);
  const oauth = createOAuthService({
    db: dependencies.db,
    oauthClient: dependencies.githubClient,
    identityService: dependencies.identityService,
    sessionService: dependencies.sessionService,
    auditService: dependencies.auditService,
    oauthCookieKey: deriveWebAuthKeys(dependencies.config.authKey).oauthCookieKey,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const rejectedCallback = async (reply: FastifyReply): Promise<FastifyReply> => {
    await dependencies.auditService.recordBestEffort({
      userId: null,
      eventType: "auth.login_failed",
      metadata: { provider: "github" },
    });
    return failure(reply);
  };

  app.get("/auth/github/start", async (request, reply) => {
    reply.header("Cache-Control", noStore);
    await dependencies.rateLimits?.oauthStart(request, reply);
    if (reply.sent) return;
    const started = await oauth.start(startReturnTo(request));
    if (started === null) return failure(reply);
    return reply
      .setCookie(names.oauth, started.attemptCookie, cookieOptions(dependencies.config.secureCookies, OAUTH_ATTEMPT_MAX_AGE_SECONDS))
      .code(302)
      .header("location", started.authorizationUrl.toString())
      .send();
  });

  app.get("/auth/github/callback", async (request, reply) => {
    reply.header("Cache-Control", noStore);
    await dependencies.rateLimits?.oauthCallback(request, reply);
    if (reply.sent) return;
    reply.clearCookie(names.oauth, commonCookieOptions);
    const rawCookies = rawCookieFields(request);
    const attemptCookies = cookieCandidates(rawCookies, names.oauth);
    const attempts = await oauth.consume(attemptCookies.values);
    const attempt = attempts[0];
    if (rawCookies.repeated || attemptCookies.invalid || attemptCookies.values.length !== 1
      || attempt === undefined || attempt === null) {
      return rejectedCallback(reply);
    }
    const input = callbackInput(request);
    if (input === null) return rejectedCallback(reply);

    let currentSession = null;
    const sessionToken = cookieCandidates(rawCookies, names.session);
    if (sessionToken.invalid || sessionToken.values.length > 1) return rejectedCallback(reply);
    if (sessionToken.values.length === 1) {
      const value = sessionToken.values[0];
      if (value === undefined || !isCanonicalWebCredential(value)) return rejectedCallback(reply);
      try {
        currentSession = await dependencies.sessionService.authenticate(value);
      } catch {
        return rejectedCallback(reply);
      }
      if (currentSession === null) {
        reply.clearCookie(names.session, commonCookieOptions);
        return rejectedCallback(reply);
      }
    }
    const completed = await oauth.complete({ ...input, attempt, currentSession });
    if (completed === null) return failure(reply);
    return reply
      .setCookie(names.session, completed.session.sessionToken, cookieOptions(dependencies.config.secureCookies, SESSION_MAX_AGE_SECONDS))
      .code(303)
      .header("location", safeReturnTo(completed.returnTo))
      .send();
  });

  const sessionRouteOptions = {
    onRequest: (_request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      reply.header("Cache-Control", noStore);
      done();
    },
  };

  app.get("/api/v1/session", {
    ...sessionRouteOptions,
    preHandler: dependencies.rateLimits === undefined
      ? middleware.requireSession
      : [middleware.requireSession, dependencies.rateLimits.ownerRead],
  }, async (request, reply) => {
    reply.header("Cache-Control", noStore);
    if (request.webSession === null) return;
    try {
      const rotated = await dependencies.sessionService.rotateCsrf(request.webSession.sessionId);
      if (rotated === null) return sendWebHttpError(request, reply, 401, "AUTH_REQUIRED");
      return reply.send({
        user: {
          id: request.webSession.userId,
          github_id: request.webSession.githubUserId,
          login: request.webSession.githubLogin,
          display_name: request.webSession.displayName,
          avatar_url: request.webSession.avatarUrl,
        },
        operator: dependencies.config.operatorGitHubIds.has(request.webSession.githubUserId),
        authenticated_at: request.webSession.authenticatedAt.toISOString(),
        csrf_token: rotated.csrfToken,
      });
    } catch {
      return sendWebHttpError(request, reply, 503, "AUTH_UNAVAILABLE");
    }
  });

  const requireLogoutMutation = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      if (!dependencies.sessionService.isAvailable()) {
        sendWebHttpError(request, reply, 503, "AUTH_UNAVAILABLE");
        return;
      }
    } catch {
      sendWebHttpError(request, reply, 503, "AUTH_UNAVAILABLE");
      return;
    }
    await middleware.requireMutation(request, reply);
  };

  app.delete("/api/v1/session", {
    ...sessionRouteOptions,
    preHandler: dependencies.rateLimits === undefined
      ? requireLogoutMutation
      : [requireLogoutMutation, dependencies.rateLimits.ownerMutation],
  }, async (request, reply) => {
    reply.header("Cache-Control", noStore);
    if (request.webSession === null) return;
    try {
      await dependencies.sessionService.revoke(request.webSession.sessionId);
    } catch {
      return sendWebHttpError(request, reply, 503, "AUTH_UNAVAILABLE");
    }
    await dependencies.auditService.recordBestEffort({
      userId: request.webSession.userId,
      eventType: "auth.logout",
      metadata: { provider: "github" },
    });
    return reply.clearCookie(names.session, commonCookieOptions).code(204).send();
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { sendWebHttpError } from "../http-errors.js";
import { isCanonicalWebCredential, type AuthenticatedWebSession, type WebSessionService } from "./session-service.js";

declare module "fastify" {
  interface FastifyRequest {
    webSession: AuthenticatedWebSession | null;
  }
}

interface WebAuthMiddlewareDependencies {
  sessionCookieName: string;
  publicOrigin: URL;
  operatorGitHubIds: ReadonlySet<string>;
  sessionService: WebSessionService;
}

const MAX_COOKIE_HEADER_LENGTH = 8_192;

function singleHeader(request: FastifyRequest, name: string): string | null {
  const rawHeaders = request.raw.rawHeaders;
  if (Array.isArray(rawHeaders) && rawHeaders.length > 0) {
    const values: string[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === name) {
        const value = rawHeaders[index + 1];
        if (value === undefined) return null;
        values.push(value);
      }
    }
    return values.length === 1 ? (values[0] ?? null) : null;
  }
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function parseSessionCookie(header: string | null, sessionCookieName: string): string | null {
  if (header === null || header.length === 0 || header.length > MAX_COOKIE_HEADER_LENGTH) {
    return null;
  }
  let selected: string | null = null;
  for (const entry of header.split(";")) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || trimmed.length === 0) {
      return null;
    }
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (name.length === 0 || value.length === 0) {
      return null;
    }
    if (name === sessionCookieName) {
      if (selected !== null) return null;
      selected = value;
    }
  }
  return selected;
}

function registerRequestSession(app: FastifyInstance): void {
  if (!app.hasRequestDecorator("webSession")) {
    app.decorateRequest("webSession", null);
  }
}

export function createWebAuthMiddleware(dependencies: WebAuthMiddlewareDependencies) {
  async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    request.webSession = null;
    const sessionToken = parseSessionCookie(singleHeader(request, "cookie"), dependencies.sessionCookieName);
    if (sessionToken === null || !isCanonicalWebCredential(sessionToken)) {
      sendWebHttpError(request, reply, 401, "AUTH_REQUIRED");
      return;
    }
    try {
      const session = await dependencies.sessionService.authenticate(sessionToken);
      if (session === null) {
        sendWebHttpError(request, reply, 401, "AUTH_REQUIRED");
        return;
      }
      request.webSession = session;
    } catch {
      sendWebHttpError(request, reply, 503, "AUTH_UNAVAILABLE");
    }
  }

  async function requireMutation(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireSession(request, reply);
    if (reply.sent || request.webSession === null) return;

    const origin = singleHeader(request, "origin");
    const csrfToken = singleHeader(request, "x-csrf-token");
    if (origin !== dependencies.publicOrigin.origin || csrfToken === null || !isCanonicalWebCredential(csrfToken)) {
      sendWebHttpError(request, reply, 403, "CSRF_FORBIDDEN");
      return;
    }
    try {
      if (!dependencies.sessionService.verifyCsrf(csrfToken, request.webSession.csrfDigest)) {
        sendWebHttpError(request, reply, 403, "CSRF_FORBIDDEN");
      }
    } catch {
      sendWebHttpError(request, reply, 503, "AUTH_UNAVAILABLE");
    }
  }

  async function requireOperator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.webSession === null) {
      await requireSession(request, reply);
    }
    if (reply.sent || request.webSession === null) return;
    if (!dependencies.operatorGitHubIds.has(request.webSession.githubUserId)) {
      sendWebHttpError(request, reply, 403, "OPERATOR_FORBIDDEN");
    }
  }

  return { register: registerRequestSession, requireSession, requireMutation, requireOperator };
}

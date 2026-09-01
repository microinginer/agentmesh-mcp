import type { IncomingMessage } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import {
  toNodeHandler,
  type NodeIncomingMessageLike,
  type NodeServerResponseLike,
} from "@modelcontextprotocol/node";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";

import { registerControlRoutes } from "./control/routes.js";
import { registerOperatorRoutes } from "./control/operator-routes.js";
import type { AgentMeshDatabase } from "./db/client.js";
import { registerAdminRoutes } from "./admin/routes.js";
import type { AdminRouteDependencies } from "./admin/routes.js";
import { AgentMeshError } from "./errors.js";
import { DEFAULT_RATE_LIMITS, type RateLimitConfig } from "./config.js";
import { latin1WireByteLength } from "./http-wire.js";
import { createSafeLogger } from "./logging.js";
import type { SafeLogger } from "./logging.js";
import { buildMcpHandler } from "./mcp/server.js";
import type { ProjectService } from "./projects/service.js";
import { createRateLimitGuards } from "./rate-limits.js";
import { registerWebAuthRoutes } from "./web-auth/routes.js";
import type { WebAuthRouteDependencies } from "./web-auth/routes.js";

interface RateLimitStore {
  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow: number,
    max: number,
  ): void;
  child(options: unknown): RateLimitStore;
}

type RateLimitStoreConstructor = new (options: unknown) => RateLimitStore;

export interface HttpAppDependencies {
  db: AgentMeshDatabase;
  signingKey: Buffer;
  projectService: Pick<ProjectService, "authenticateProject">;
  host: string;
  allowedHosts: string[];
  trustedProxies?: string[];
  admin: AdminRouteDependencies | null;
  web?: WebAuthRouteDependencies | null;
  logger?: SafeLogger;
  rateLimits?: RateLimitConfig;
  rateLimitStore?: RateLimitStoreConstructor;
  readinessCheck?: () => Promise<boolean>;
  webAssetsPath?: string | null;
}

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

function bearerFromHeader(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

const API_CONTENT_SECURITY_POLICY = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const WEB_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
  + "img-src 'self' data: https://avatars.githubusercontent.com https://github.com; "
  + "base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const HTTP_MAX_HEADER_SIZE = 16_384;
const READINESS_QUERY_TIMEOUT_MS = 750;
const READINESS_TOTAL_TIMEOUT_MS = 1_500;

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("bounded operation timed out")), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function databaseReadinessCheck(db: AgentMeshDatabase): () => Promise<boolean> {
  let expected: { hash: string; folderMillis: number } | undefined;
  try {
    expected = readMigrationFiles({ migrationsFolder: resolve(process.cwd(), "drizzle") }).at(-1);
  } catch {
    expected = undefined;
  }
  if (expected === undefined) return async () => false;

  return async () => {
    try {
      return await db.transaction(async (transaction) => {
        await transaction.execute(sql.raw(`SET LOCAL statement_timeout = '${READINESS_QUERY_TIMEOUT_MS}ms'`));
        const migration = await transaction.execute(sql`
          SELECT
            1 AS database_ready,
            EXISTS (
              SELECT 1
              FROM drizzle.__drizzle_migrations
              WHERE hash = ${expected.hash}
                AND created_at = ${expected.folderMillis}
            ) AS migration_current
        `);
        return migration.rows[0]?.migration_current === true;
      });
    } catch {
      return false;
    }
  };
}

function singleFlight(check: () => Promise<boolean>): () => Promise<boolean> {
  let active: Promise<boolean> | null = null;
  return () => {
    if (active !== null) return active;
    const flight = Promise.resolve()
      .then(check)
      .catch(() => false)
      .finally(() => {
        if (active === flight) active = null;
      });
    active = flight;
    return flight;
  };
}

function applySecurityHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Content-Security-Policy", API_CONTENT_SECURITY_POLICY);
}

function applyWebSecurityHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Content-Security-Policy", WEB_CONTENT_SECURITY_POLICY);
}

function isSafeSpaPath(rawUrl: string | undefined): boolean {
  const rawPath = (rawUrl ?? "").split("?", 1)[0] ?? "";
  if (/%(?:2e|2f|5c)/i.test(rawPath) || rawPath.includes("\\")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (decoded.split("/").some((segment) => segment.startsWith("."))) return false;
  return decoded === "/"
    || decoded === "/guide"
    || decoded === "/app"
    || decoded.startsWith("/app/")
    || decoded === "/ops"
    || decoded.startsWith("/ops/");
}

function isHashedWebAsset(pathName: string): boolean {
  const normalized = pathName.startsWith("/") ? pathName.slice(1) : pathName;
  return !normalized.includes("/")
    && !normalized.endsWith(".map")
    && /^[A-Za-z0-9][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(normalized);
}

function webAssetNameFromUrl(url: string): string | null {
  const path = url.split("?", 1)[0] ?? "";
  if (!path.startsWith("/assets/")) return null;
  const name = path.slice("/assets/".length);
  if (name.includes("%") || name.includes("\\") || !isHashedWebAsset(name)) return null;
  return name;
}

function referencedWebAssetNames(indexBytes: Buffer): string[] | null {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(indexBytes);
  } catch {
    return null;
  }
  if (!/^\s*<!doctype html>/i.test(html) || !/<[a-z][^>]*\bid=["']root["'][^>]*>/i.test(html)) {
    return null;
  }

  const names = new Set<string>();
  const referencePattern = /(?:src|href)\s*=\s*["'](\/assets\/[^"'?#]+)["']/gi;
  for (const match of html.matchAll(referencePattern)) {
    const reference = match[1];
    if (reference === undefined) return null;
    const name = webAssetNameFromUrl(reference);
    if (name === null) return null;
    names.add(name);
  }
  const references = [...names];
  return references.some((name) => name.endsWith(".js")) ? references : null;
}

function webBuildAvailable(webAssetsPath: string): boolean {
  try {
    const indexPath = join(webAssetsPath, "index.html");
    const assetsPath = join(webAssetsPath, "assets");
    if (!statSync(indexPath).isFile() || !statSync(assetsPath).isDirectory()) return false;
    const references = referencedWebAssetNames(readFileSync(indexPath));
    if (references === null) return false;
    return references.every((name) => readFileSync(join(assetsPath, name)).byteLength > 0);
  } catch {
    return false;
  }
}

async function readValidatedWebIndex(webAssetsPath: string): Promise<Buffer | null> {
  try {
    const indexBytes = await readFile(join(webAssetsPath, "index.html"));
    const references = referencedWebAssetNames(indexBytes);
    if (references === null) return null;
    const assets = await Promise.all(
      references.map((name) => readFile(join(webAssetsPath, "assets", name))),
    );
    return assets.every((asset) => asset.byteLength > 0) ? indexBytes : null;
  } catch {
    return null;
  }
}

function sendWebUnavailable(reply: FastifyReply): FastifyReply {
  applySecurityHeaders(reply);
  reply.type("application/json; charset=utf-8").code(503);
  return reply.request.method === "HEAD"
    ? reply.send()
    : reply.send({ error: "web_assets_unavailable" });
}

function registerWebProductRoutes(app: FastifyInstance, webAssetsPath: string): void {
  const spaPaths = ["/", "/guide", "/app", "/app/*", "/ops", "/ops/*"];
  const rootAssets = {
    "/agentmesh-mark.svg": ["agentmesh-mark.svg", "image/svg+xml"],
    "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
    "/favicon-32x32.png": ["favicon-32x32.png", "image/png"],
    "/favicon.ico": ["favicon.ico", "image/x-icon"],
    "/favicon.svg": ["favicon.svg", "image/svg+xml"],
    "/icon-192.png": ["icon-192.png", "image/png"],
    "/icon-512.png": ["icon-512.png", "image/png"],
    "/site.webmanifest": ["site.webmanifest", "application/manifest+json"],
  } as const;

  if (!webBuildAvailable(webAssetsPath)) {
    for (const path of spaPaths) {
      app.get(path, (_request, reply) => sendWebUnavailable(reply));
    }
    return;
  }

  app.register(async (assetsApp) => {
    assetsApp.setErrorHandler((_error, _request, reply) => sendWebUnavailable(reply));
    assetsApp.addHook("preHandler", async (request, reply) => {
      const name = webAssetNameFromUrl(request.raw.url ?? "");
      if (name === null) return reply.callNotFound();
      try {
        const asset = await readFile(join(webAssetsPath, "assets", name));
        if (asset.byteLength === 0) return sendWebUnavailable(reply);
      } catch {
        return sendWebUnavailable(reply);
      }
    });
    await assetsApp.register(fastifyStatic, {
      root: join(webAssetsPath, "assets"),
      prefix: "/assets/",
      index: false,
      dotfiles: "ignore",
      cacheControl: false,
      allowedPath: (pathName) => isHashedWebAsset(pathName),
      setHeaders: (reply) => {
        applyWebSecurityHeaders(reply);
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    });
  });

  for (const [route, [fileName, contentType]] of Object.entries(rootAssets)) {
    app.get(route, async (_request, reply) => {
      try {
        const asset = await readFile(join(webAssetsPath, fileName));
        if (asset.byteLength === 0) return sendWebUnavailable(reply);
        applyWebSecurityHeaders(reply);
        reply.header("Cache-Control", "no-cache");
        return reply.type(contentType).send(asset);
      } catch {
        return sendWebUnavailable(reply);
      }
    });
  }

  for (const path of spaPaths) {
    app.get(path, async (request, reply) => {
      if (!isSafeSpaPath(request.raw.url)) return reply.callNotFound();
      const indexBytes = await readValidatedWebIndex(webAssetsPath);
      if (indexBytes === null) return sendWebUnavailable(reply);
      applyWebSecurityHeaders(reply);
      reply.header("Cache-Control", "no-cache");
      return reply.type("text/html; charset=utf-8").send(indexBytes);
    });
  }
}

function exceedsHttpHeaderAdmission(request: { raw: { rawHeaders: string[]; url?: string | undefined } }): boolean {
  const rawHeaders = request.raw.rawHeaders;
  if (rawHeaders.length % 2 !== 0 || rawHeaders.length >= HTTP_MAX_HEADER_SIZE * 2) return true;
  let trackedBytes = 0;
  const track = (value: string): boolean => {
    const remaining = HTTP_MAX_HEADER_SIZE - trackedBytes;
    if (value.length >= remaining) return false;
    const valueLength = latin1WireByteLength(value);
    if (valueLength === null) return false;
    trackedBytes += valueLength;
    return trackedBytes < HTTP_MAX_HEADER_SIZE;
  };
  if (!track(request.raw.url ?? "")) return true;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name === undefined || value === undefined) return true;
    if (!track(name) || !track(value)) return true;
  }
  return false;
}

export function buildHttpApp(dependencies: HttpAppDependencies) {
  const logger = dependencies.logger ?? createSafeLogger();
  const trustedProxies = dependencies.trustedProxies ?? [];
  const app = Fastify({
    http: { maxHeaderSize: HTTP_MAX_HEADER_SIZE },
    trustProxy: trustedProxies.length === 0 ? false : trustedProxies,
  });
  app.server.maxHeadersCount = HTTP_MAX_HEADER_SIZE - 1;
  const mcpHandler = buildMcpHandler({
    db: dependencies.db,
    signingKey: dependencies.signingKey,
    logger,
  });
  const nodeHandler = toNodeHandler({
    fetch: async (request, options) => {
      const response = await mcpHandler.fetch(request, options);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("Content-Security-Policy", API_CONTENT_SECURITY_POLICY);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!exceedsHttpHeaderAdmission(request)) return;
    applySecurityHeaders(reply);
    await reply.code(431).send({ error: "request headers too large" });
  });
  app.addHook("onRequest", (_request, reply, done) => {
    applySecurityHeaders(reply);
    done();
  });
  app.addHook("onRequest", async (request, reply) => {
    const host = validateHostHeader(request.headers.host, dependencies.allowedHosts);
    if (!host.ok) {
      await reply.code(403).send({ error: "forbidden" });
      return;
    }
    const origin = validateOriginHeader(request.headers.origin, dependencies.allowedHosts);
    if (!origin.ok) {
      await reply.code(403).send({ error: "forbidden" });
    }
  });

  const ready = singleFlight(dependencies.readinessCheck ?? databaseReadinessCheck(dependencies.db));
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    let available = false;
    try {
      available = await bounded(Promise.resolve(ready()), READINESS_TOTAL_TIMEOUT_MS);
    } catch {
      available = false;
    }
    return available
      ? reply.send({ status: "ready" })
      : reply.code(503).send({ status: "unavailable" });
  });

  if (dependencies.webAssetsPath !== undefined && dependencies.webAssetsPath !== null) {
    registerWebProductRoutes(app, dependencies.webAssetsPath);
  }

  registerAdminRoutes(app, dependencies.admin);
  app.register(async (protectedApp) => {
    await protectedApp.register(fastifyRateLimit, {
      global: false,
      cache: 5_000,
      ...(dependencies.rateLimitStore === undefined ? {} : { store: dependencies.rateLimitStore }),
    });
    if (!protectedApp.hasRequestDecorator("rateLimitConnectionId")) {
      protectedApp.decorateRequest("rateLimitConnectionId", null);
    }
    const limits = createRateLimitGuards(
      protectedApp,
      dependencies.rateLimits ?? { ...DEFAULT_RATE_LIMITS },
    );

    if (dependencies.web !== undefined && dependencies.web !== null) {
      await protectedApp.register(fastifyCookie, { hook: false });
      const web = { ...dependencies.web, rateLimits: limits.web };
      registerWebAuthRoutes(protectedApp, web);
      registerControlRoutes(protectedApp, web);
      registerOperatorRoutes(protectedApp, web);
    }

    protectedApp.post("/mcp", async (request, reply) => {
      const bearer = bearerFromHeader(request.headers.authorization);
      if (bearer === null) {
        logger.write({ event: "http.request_failed" });
        return reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "unauthorized" });
      }

      let authenticatedProject: Awaited<ReturnType<ProjectService["authenticateProject"]>>;
      try {
        authenticatedProject = await dependencies.projectService.authenticateProject(bearer);
      } catch (error) {
        if (error instanceof AgentMeshError && error.code === "PROJECT_AUTH_INVALID") {
          logger.write({ event: "http.request_failed" });
          return reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "unauthorized" });
        }
        logger.write({ event: "http.request_failed", error_code: "INTERNAL_ERROR" });
        return reply.code(500).send({ error: "internal_error" });
      }

      request.rateLimitConnectionId = authenticatedProject.connectionTokenId;
      await limits.mcp(request, reply);
      if (reply.sent) return;

      (request.raw as AuthenticatedIncomingMessage).auth = {
        token: "validated-project-token",
        clientId: authenticatedProject.projectId,
        scopes: ["agentmesh"],
        extra: { connectionTokenId: authenticatedProject.connectionTokenId },
      };
      reply.hijack();
      await nodeHandler(
        request.raw as unknown as NodeIncomingMessageLike,
        reply.raw as unknown as NodeServerResponseLike,
        request.body,
      );
    });
  });

  app.addHook("onClose", async () => {
    await mcpHandler.close();
  });

  return app;
}

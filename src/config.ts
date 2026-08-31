import { createHash, createHmac } from "node:crypto";

import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "postgres:" || protocol === "postgresql:";
      } catch {
        return false;
      }
    }),
  AGENT_SESSION_SIGNING_KEY: z.string().regex(/^[A-Za-z0-9_-]+$/),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  ALLOWED_HOSTS: z.string().optional(),
  AGENTMESH_ADMIN_TOKEN: z.string().optional(),
  AGENTMESH_ADMIN_COOKIE_SECURE: z.enum(["0", "1"]).default("0"),
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  GITHUB_OAUTH_CALLBACK_URL: z.string().optional(),
  AGENTMESH_PUBLIC_ORIGIN: z.string().optional(),
  AGENTMESH_WEB_AUTH_KEY: z.string().optional(),
  AGENTMESH_OPERATOR_GITHUB_IDS: z.string().optional(),
  AGENTMESH_PROJECT_LIMIT: z.string().optional(),
  AGENTMESH_TOKEN_TTL_DAYS: z.string().optional(),
  AGENTMESH_RATE_LIMIT_OAUTH_START: z.string().optional(),
  AGENTMESH_RATE_LIMIT_OWNER_READ: z.string().optional(),
  AGENTMESH_RATE_LIMIT_OWNER_MUTATION: z.string().optional(),
  AGENTMESH_RATE_LIMIT_CONNECTION_CREATE: z.string().optional(),
  AGENTMESH_RATE_LIMIT_MCP: z.string().optional(),
});

const hostedRequiredEnvironmentNames = [
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GITHUB_OAUTH_CALLBACK_URL",
  "AGENTMESH_PUBLIC_ORIGIN",
  "AGENTMESH_WEB_AUTH_KEY",
  "AGENTMESH_OPERATOR_GITHUB_IDS",
  "AGENTMESH_PROJECT_LIMIT",
] as const;

type HostedRequiredEnvironmentName = (typeof hostedRequiredEnvironmentNames)[number];

const DEFAULT_TOKEN_TTL_DAYS = 90;

export interface RateLimitConfig {
  oauthStart: number;
  ownerRead: number;
  ownerMutation: number;
  connectionCreate: number;
  mcp: number;
}

export const DEFAULT_RATE_LIMITS: Readonly<RateLimitConfig> = Object.freeze({
  oauthStart: 20,
  ownerRead: 300,
  ownerMutation: 60,
  connectionCreate: 10,
  mcp: 600,
});

export interface AdminConfig {
  tokenDigest: Buffer;
  sessionSigningKey: Buffer;
  secureCookies: boolean;
}

export interface WebAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: URL;
  publicOrigin: URL;
  authKey: Buffer;
  operatorGitHubIds: ReadonlySet<string>;
  projectLimit: number;
  tokenTtlDays: number;
  secureCookies: boolean;
}

export interface AgentMeshConfig {
  databaseUrl: string;
  signingKey: Buffer;
  host: string;
  port: number;
  allowedHosts: string[];
  admin: AdminConfig | null;
  web: WebAuthConfig | null;
  rateLimits: RateLimitConfig;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function parseHostedUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid AgentMesh configuration: ${field}`);
  }

  const loopbackHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if ((url.protocol !== "https:" && !loopbackHttp) || url.username !== "" || url.password !== "") {
    throw new Error(`Invalid AgentMesh configuration: ${field}`);
  }
  return url;
}

function parsePublicOrigin(value: string): URL {
  const url = parseHostedUrl(value, "AGENTMESH_PUBLIC_ORIGIN");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Invalid AgentMesh configuration: AGENTMESH_PUBLIC_ORIGIN");
  }
  return url;
}

function parseOAuthCallbackUrl(value: string): URL {
  const url = parseHostedUrl(value, "GITHUB_OAUTH_CALLBACK_URL");
  if (url.pathname !== "/auth/github/callback" || url.search !== "" || url.hash !== "") {
    throw new Error("Invalid AgentMesh configuration: GITHUB_OAUTH_CALLBACK_URL");
  }
  return url;
}

function decodeBase64urlKey(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid AgentMesh configuration: ${field}`);
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new Error(`Invalid AgentMesh configuration: ${field}`);
  }
  return decoded;
}

function parseBoundedInteger(value: string, field: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid AgentMesh configuration: ${field}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Invalid AgentMesh configuration: ${field}`);
  }
  return number;
}

function parseRateLimit(value: string | undefined, field: string, defaultValue: number): number {
  return isBlank(value) ? defaultValue : parseBoundedInteger(value ?? "", field, 1, 100_000);
}

function parseOperatorGitHubIds(value: string): ReadonlySet<string> {
  const ids = value.split(",").map((entry) => entry.trim());
  if (ids.length === 0 || ids.some((id) => !/^[1-9]\d*$/.test(id))) {
    throw new Error("Invalid AgentMesh configuration: AGENTMESH_OPERATOR_GITHUB_IDS");
  }
  return new Set(ids);
}

function createWebAuthConfig(environment: z.infer<typeof environmentSchema>): WebAuthConfig | null {
  const requiredValues = hostedRequiredEnvironmentNames.map((name) => ({ name, value: environment[name] }));
  if (requiredValues.every(({ value }) => isBlank(value)) && isBlank(environment.AGENTMESH_TOKEN_TTL_DAYS)) {
    return null;
  }

  const missingName = requiredValues.find(({ value }) => isBlank(value))?.name;
  if (missingName !== undefined) {
    throw new Error(`Invalid AgentMesh configuration: ${missingName}`);
  }

  const values = Object.fromEntries(
    requiredValues.map(({ name, value }) => [name, value]),
  ) as Record<HostedRequiredEnvironmentName, string>;
  const callbackUrl = parseOAuthCallbackUrl(values.GITHUB_OAUTH_CALLBACK_URL);
  const publicOrigin = parsePublicOrigin(values.AGENTMESH_PUBLIC_ORIGIN);
  if (callbackUrl.origin !== publicOrigin.origin) {
    throw new Error("Invalid AgentMesh configuration: GITHUB_OAUTH_CALLBACK_URL, AGENTMESH_PUBLIC_ORIGIN");
  }

  const web = {
    clientId: values.GITHUB_OAUTH_CLIENT_ID,
    callbackUrl,
    publicOrigin,
    operatorGitHubIds: parseOperatorGitHubIds(values.AGENTMESH_OPERATOR_GITHUB_IDS),
    projectLimit: parseBoundedInteger(values.AGENTMESH_PROJECT_LIMIT, "AGENTMESH_PROJECT_LIMIT", 0, 100),
    tokenTtlDays:
      isBlank(environment.AGENTMESH_TOKEN_TTL_DAYS)
        ? DEFAULT_TOKEN_TTL_DAYS
        : parseBoundedInteger(environment.AGENTMESH_TOKEN_TTL_DAYS ?? "", "AGENTMESH_TOKEN_TTL_DAYS", 1, 3650),
    secureCookies: publicOrigin.protocol === "https:",
  } as Omit<WebAuthConfig, "clientSecret" | "authKey">;

  Object.defineProperties(web, {
    clientSecret: { value: values.GITHUB_OAUTH_CLIENT_SECRET, enumerable: false },
    authKey: { value: decodeBase64urlKey(values.AGENTMESH_WEB_AUTH_KEY, "AGENTMESH_WEB_AUTH_KEY"), enumerable: false },
  });
  return web as WebAuthConfig;
}

export function loadConfig(environment: Record<string, string | undefined>): AgentMeshConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]).filter(Boolean))];
    throw new Error(`Invalid AgentMesh configuration: ${fields.join(", ")}`);
  }

  const signingKey = Buffer.from(parsed.data.AGENT_SESSION_SIGNING_KEY, "base64url");
  if (signingKey.byteLength < 32) {
    throw new Error("Invalid AgentMesh configuration: AGENT_SESSION_SIGNING_KEY");
  }

  const allowedHosts =
    parsed.data.ALLOWED_HOSTS === undefined
      ? ["127.0.0.1", "localhost", "[::1]"]
      : parsed.data.ALLOWED_HOSTS.split(",")
          .map((host) => host.trim())
          .filter((host) => host.length > 0);
  if (allowedHosts.length === 0) {
    throw new Error("Invalid AgentMesh configuration: ALLOWED_HOSTS");
  }

  const adminToken = parsed.data.AGENTMESH_ADMIN_TOKEN;
  let admin: AdminConfig | null = null;
  if (adminToken !== undefined && adminToken !== "") {
    if (!/^[A-Za-z0-9_-]+$/.test(adminToken) || Buffer.from(adminToken, "base64url").byteLength < 32) {
      throw new Error("Invalid AgentMesh configuration: AGENTMESH_ADMIN_TOKEN");
    }
    admin = {
      tokenDigest: createHash("sha256").update(adminToken, "utf8").digest(),
      sessionSigningKey: createHmac("sha256", signingKey)
        .update("agentmesh-admin-session-v1", "utf8")
        .digest(),
      secureCookies: parsed.data.AGENTMESH_ADMIN_COOKIE_SECURE === "1",
    };
  }

  const web = createWebAuthConfig(parsed.data);
  const rateLimits: RateLimitConfig = {
    oauthStart: parseRateLimit(
      parsed.data.AGENTMESH_RATE_LIMIT_OAUTH_START,
      "AGENTMESH_RATE_LIMIT_OAUTH_START",
      DEFAULT_RATE_LIMITS.oauthStart,
    ),
    ownerRead: parseRateLimit(
      parsed.data.AGENTMESH_RATE_LIMIT_OWNER_READ,
      "AGENTMESH_RATE_LIMIT_OWNER_READ",
      DEFAULT_RATE_LIMITS.ownerRead,
    ),
    ownerMutation: parseRateLimit(
      parsed.data.AGENTMESH_RATE_LIMIT_OWNER_MUTATION,
      "AGENTMESH_RATE_LIMIT_OWNER_MUTATION",
      DEFAULT_RATE_LIMITS.ownerMutation,
    ),
    connectionCreate: parseRateLimit(
      parsed.data.AGENTMESH_RATE_LIMIT_CONNECTION_CREATE,
      "AGENTMESH_RATE_LIMIT_CONNECTION_CREATE",
      DEFAULT_RATE_LIMITS.connectionCreate,
    ),
    mcp: parseRateLimit(
      parsed.data.AGENTMESH_RATE_LIMIT_MCP,
      "AGENTMESH_RATE_LIMIT_MCP",
      DEFAULT_RATE_LIMITS.mcp,
    ),
  };

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    signingKey,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    allowedHosts,
    admin,
    web,
    rateLimits,
  };
}

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
});

export interface AdminConfig {
  tokenDigest: Buffer;
  sessionSigningKey: Buffer;
  secureCookies: boolean;
}

export interface AgentMeshConfig {
  databaseUrl: string;
  signingKey: Buffer;
  host: string;
  port: number;
  allowedHosts: string[];
  admin: AdminConfig | null;
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

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    signingKey,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    allowedHosts,
    admin,
  };
}

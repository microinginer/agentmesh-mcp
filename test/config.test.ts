import { describe, expect, it } from "vitest";

import { createHash, createHmac } from "node:crypto";

import { loadConfig } from "../src/config.js";

const key = Buffer.alloc(32, 7).toString("base64url");
const rawAdminToken = Buffer.alloc(32, 9).toString("base64url");
const databaseUrl = "postgres://agentmesh:secret@postgres:5432/agentmesh";

function hostedEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: databaseUrl,
    AGENT_SESSION_SIGNING_KEY: key,
    GITHUB_OAUTH_CLIENT_ID: "test-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
    GITHUB_OAUTH_CALLBACK_URL: "https://agentmesh.example/auth/github/callback",
    AGENTMESH_PUBLIC_ORIGIN: "https://agentmesh.example",
    AGENTMESH_WEB_AUTH_KEY: Buffer.alloc(32, 4).toString("base64url"),
    AGENTMESH_OPERATOR_GITHUB_IDS: "1,42",
    AGENTMESH_PROJECT_LIMIT: "5",
    ...overrides,
  };
}

describe("runtime configuration", () => {
  it("loads validated defaults and decodes the signing key", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://agentmesh:secret@postgres:5432/agentmesh",
      AGENT_SESSION_SIGNING_KEY: key,
    });

    expect(config).toMatchObject({
      databaseUrl: "postgres://agentmesh:secret@postgres:5432/agentmesh",
      host: "127.0.0.1",
      port: 3000,
      allowedHosts: ["127.0.0.1", "localhost", "[::1]"],
      trustedProxies: [],
    });
    expect(config.signingKey).toEqual(Buffer.alloc(32, 7));
    expect(config.rateLimits).toEqual({
      oauthStart: 20,
      inviteCapture: 30,
      inviteRedeem: 10,
      ownerRead: 300,
      ownerMutation: 60,
      connectionCreate: 10,
      mcp: 600,
    });
  });

  it("loads bounded self-hosted rate-limit overrides independently of hosted mode", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      AGENT_SESSION_SIGNING_KEY: key,
      AGENTMESH_RATE_LIMIT_OAUTH_START: "7",
      AGENTMESH_RATE_LIMIT_INVITE_CAPTURE: "12",
      AGENTMESH_RATE_LIMIT_INVITE_REDEEM: "13",
      AGENTMESH_RATE_LIMIT_OWNER_READ: "8",
      AGENTMESH_RATE_LIMIT_OWNER_MUTATION: "9",
      AGENTMESH_RATE_LIMIT_CONNECTION_CREATE: "10",
      AGENTMESH_RATE_LIMIT_MCP: "11",
    });

    expect(config.web).toBeNull();
    expect(config.rateLimits).toEqual({
      oauthStart: 7,
      inviteCapture: 12,
      inviteRedeem: 13,
      ownerRead: 8,
      ownerMutation: 9,
      connectionCreate: 10,
      mcp: 11,
    });
  });

  it.each([
    ["AGENTMESH_RATE_LIMIT_OAUTH_START", "0"],
    ["AGENTMESH_RATE_LIMIT_INVITE_CAPTURE", "-1"],
    ["AGENTMESH_RATE_LIMIT_INVITE_REDEEM", "1.5"],
    ["AGENTMESH_RATE_LIMIT_OWNER_READ", "-1"],
    ["AGENTMESH_RATE_LIMIT_OWNER_MUTATION", "1.5"],
    ["AGENTMESH_RATE_LIMIT_CONNECTION_CREATE", "100001"],
    ["AGENTMESH_RATE_LIMIT_MCP", "not-a-number"],
  ])("fails closed for invalid bounded rate setting %s", (name, value) => {
    expect(() => loadConfig({
      DATABASE_URL: databaseUrl,
      AGENT_SESSION_SIGNING_KEY: key,
      [name]: value,
    })).toThrow(`Invalid AgentMesh configuration: ${name}`);
  });

  it("accepts an explicit bind address, port, host allow-list, and exact trusted proxy ranges", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://agentmesh:secret@postgres:5432/agentmesh",
      AGENT_SESSION_SIGNING_KEY: key,
      HOST: "0.0.0.0",
      PORT: "8080",
      ALLOWED_HOSTS: "agentmesh.example.com",
      AGENTMESH_TRUSTED_PROXIES: "172.30.0.2,10.42.0.0/24,2001:db8:42::2,2001:db8:42::/64,::ffff:192.0.2.0/120",
    });

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
      allowedHosts: ["agentmesh.example.com", "127.0.0.1", "localhost", "[::1]"],
      trustedProxies: [
        "172.30.0.2",
        "10.42.0.0/24",
        "2001:db8:42::2",
        "2001:db8:42::/64",
        "::ffff:192.0.2.0/120",
      ],
    });
  });

  it.each([
    "loopback",
    "0.0.0.0/0",
    "::/0",
    "::/1",
    "::/80",
    "::ffff:0:0/95",
    "::ffff:0:0/96",
    "::ffff:0:0/97,::ffff:128.0.0.0/97",
    "0.0.0.0/1,128.0.0.0/1",
    "0.0.0.0/1,::ffff:128.0.0.0/97",
    "192.0.0.0/2,0.0.0.0/1,128.0.0.0/2",
    "172.30.0.2/33",
    "2001:db8::1/129",
    "10.42.0.0/08",
    "172.30.0.0/024",
    "2001:db8::/064",
    "172.30.0.2,,172.30.0.3",
    "not-an-address",
  ])("fails closed for unsafe trusted proxy entry %s", (trustedProxies) => {
    expect(() => loadConfig({
      DATABASE_URL: databaseUrl,
      AGENT_SESSION_SIGNING_KEY: key,
      AGENTMESH_TRUSTED_PROXIES: trustedProxies,
    })).toThrow("Invalid AgentMesh configuration: AGENTMESH_TRUSTED_PROXIES");
  });

  it.each([undefined, ""])("disables the local admin dashboard when its token is absent or empty", (adminToken) => {
    const config = loadConfig({
      DATABASE_URL: "postgres://agentmesh:secret@postgres:5432/agentmesh",
      AGENT_SESSION_SIGNING_KEY: key,
      AGENTMESH_ADMIN_TOKEN: adminToken,
    });

    expect(config.admin).toBeNull();
  });

  it("derives local admin credentials without retaining the raw token", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://agentmesh:secret@postgres:5432/agentmesh",
      AGENT_SESSION_SIGNING_KEY: key,
      AGENTMESH_ADMIN_TOKEN: rawAdminToken,
      AGENTMESH_ADMIN_COOKIE_SECURE: "1",
    });

    expect(config.admin).toEqual({
      tokenDigest: createHash("sha256").update(rawAdminToken).digest(),
      sessionSigningKey: createHmac("sha256", Buffer.alloc(32, 7))
        .update("agentmesh-admin-session-v1")
        .digest(),
      secureCookies: true,
    });
    expect(Object.values(config.admin ?? {})).not.toContain(rawAdminToken);
  });

  it("keeps web authentication disabled when every hosted setting is blank", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      AGENT_SESSION_SIGNING_KEY: key,
      GITHUB_OAUTH_CLIENT_ID: "",
      GITHUB_OAUTH_CLIENT_SECRET: "",
      GITHUB_OAUTH_CALLBACK_URL: "",
      AGENTMESH_PUBLIC_ORIGIN: "",
      AGENTMESH_WEB_AUTH_KEY: "",
      AGENTMESH_OPERATOR_GITHUB_IDS: "",
      AGENTMESH_PROJECT_LIMIT: "",
    });

    expect(config.web).toBeNull();
  });

  it("keeps web authentication disabled when every hosted setting is whitespace", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      AGENT_SESSION_SIGNING_KEY: key,
      GITHUB_OAUTH_CLIENT_ID: " \t ",
      GITHUB_OAUTH_CLIENT_SECRET: " \t ",
      GITHUB_OAUTH_CALLBACK_URL: " \t ",
      AGENTMESH_PUBLIC_ORIGIN: " \t ",
      AGENTMESH_WEB_AUTH_KEY: " \t ",
      AGENTMESH_OPERATOR_GITHUB_IDS: " \t ",
      AGENTMESH_PROJECT_LIMIT: " \t ",
      AGENTMESH_TOKEN_TTL_DAYS: " \t ",
    });

    expect(config.web).toBeNull();
  });

  it("enables web auth only when the complete OAuth group is present", () => {
    const config = loadConfig(hostedEnvironment());

    expect(config.web).toMatchObject({
      clientId: "test-client-id",
      callbackUrl: new URL("https://agentmesh.example/auth/github/callback"),
      publicOrigin: new URL("https://agentmesh.example"),
      authKey: Buffer.alloc(32, 4),
      operatorGitHubIds: new Set(["1", "42"]),
      projectLimit: 5,
      tokenTtlDays: 90,
      secureCookies: true,
    });
    expect(config.web?.clientSecret).toBe("test-client-secret");
    expect(JSON.stringify(config.web)).not.toContain("test-client-secret");
    expect(Object.values(config.web ?? {})).not.toContain("test-client-secret");
  });

  it("permits an HTTP loopback origin for local hosted development", () => {
    const config = loadConfig(
      hostedEnvironment({
        GITHUB_OAUTH_CALLBACK_URL: "http://localhost:3000/auth/github/callback",
        AGENTMESH_PUBLIC_ORIGIN: "http://localhost:3000",
        AGENTMESH_PROJECT_LIMIT: "0",
        AGENTMESH_TOKEN_TTL_DAYS: "30",
      }),
    );

    expect(config.web).toMatchObject({ projectLimit: 0, tokenTtlDays: 30, secureCookies: false });
  });

  it("treats whitespace-only optional hosted settings as absent", () => {
    const config = loadConfig(hostedEnvironment({ AGENTMESH_TOKEN_TTL_DAYS: " \t " }));

    expect(config.web?.tokenTtlDays).toBe(90);
  });

  it.each([
    { GITHUB_OAUTH_CLIENT_SECRET: undefined },
    { GITHUB_OAUTH_CLIENT_SECRET: "" },
    { GITHUB_OAUTH_CLIENT_SECRET: " \t " },
    {
      GITHUB_OAUTH_CLIENT_ID: "",
      GITHUB_OAUTH_CLIENT_SECRET: "",
      GITHUB_OAUTH_CALLBACK_URL: "",
      AGENTMESH_PUBLIC_ORIGIN: "",
      AGENTMESH_WEB_AUTH_KEY: "",
      AGENTMESH_OPERATOR_GITHUB_IDS: "",
      AGENTMESH_PROJECT_LIMIT: "",
      AGENTMESH_TOKEN_TTL_DAYS: "30",
    },
    { GITHUB_OAUTH_CALLBACK_URL: "https://other.example/auth/github/callback" },
    { GITHUB_OAUTH_CALLBACK_URL: "http://agentmesh.example/auth/github/callback", AGENTMESH_PUBLIC_ORIGIN: "http://agentmesh.example" },
    { AGENTMESH_PUBLIC_ORIGIN: "https://agentmesh.example/app" },
    { AGENTMESH_PUBLIC_ORIGIN: "https://agentmesh.example/?unexpected=value" },
    { AGENTMESH_PUBLIC_ORIGIN: "https://agentmesh.example/#fragment" },
    { AGENTMESH_PUBLIC_ORIGIN: "https://operator:password@agentmesh.example" },
    { AGENTMESH_PUBLIC_ORIGIN: "//agentmesh.example" },
    { GITHUB_OAUTH_CALLBACK_URL: "https://agentmesh.example/auth/github/not-callback" },
    { GITHUB_OAUTH_CALLBACK_URL: "https://agentmesh.example/auth/github/callback?code=unexpected" },
    { GITHUB_OAUTH_CALLBACK_URL: "https://agentmesh.example/auth/github/callback#fragment" },
    { GITHUB_OAUTH_CALLBACK_URL: "https://operator:password@agentmesh.example/auth/github/callback" },
    { GITHUB_OAUTH_CALLBACK_URL: "//agentmesh.example/auth/github/callback" },
    { AGENTMESH_OPERATOR_GITHUB_IDS: "1,not-a-number" },
    { AGENTMESH_OPERATOR_GITHUB_IDS: "1,,42" },
    { AGENTMESH_PROJECT_LIMIT: "101" },
    { AGENTMESH_PROJECT_LIMIT: "1.5" },
    { AGENTMESH_TOKEN_TTL_DAYS: "0" },
    { AGENTMESH_WEB_AUTH_KEY: Buffer.alloc(31, 4).toString("base64url") },
    { AGENTMESH_WEB_AUTH_KEY: `${key}=` },
  ])("fails closed for invalid hosted configuration without echoing secrets", (overrides) => {
    const secret = "test-client-secret";
    const error = () => loadConfig(hostedEnvironment(overrides));

    expect(error).toThrow("Invalid AgentMesh configuration");
    expect(error).not.toThrow(secret);
  });

  it.each([
    { DATABASE_URL: "", AGENT_SESSION_SIGNING_KEY: key },
    { DATABASE_URL: "https://example.com", AGENT_SESSION_SIGNING_KEY: key },
    {
      DATABASE_URL: databaseUrl,
      AGENT_SESSION_SIGNING_KEY: Buffer.alloc(31).toString("base64url"),
    },
    {
      DATABASE_URL: "postgres://agentmesh:secret@postgres:5432/agentmesh",
      AGENT_SESSION_SIGNING_KEY: key,
      PORT: "70000",
    },
    {
      DATABASE_URL: "postgres://agentmesh:secret@postgres:5432/agentmesh",
      AGENT_SESSION_SIGNING_KEY: key,
      ALLOWED_HOSTS: " , ",
    },
    {
      DATABASE_URL: "postgres://agentmesh:secret@postgres:5432/agentmesh",
      AGENT_SESSION_SIGNING_KEY: key,
      AGENTMESH_ADMIN_TOKEN: Buffer.alloc(31, 9).toString("base64url"),
    },
    {
      DATABASE_URL: "postgres://agentmesh:secret@postgres:5432/agentmesh",
      AGENT_SESSION_SIGNING_KEY: key,
      AGENTMESH_ADMIN_TOKEN: "not base64url!",
    },
  ])("rejects unsafe or incomplete configuration", (environment) => {
    expect(() => loadConfig(environment)).toThrow("Invalid AgentMesh configuration");
  });
});

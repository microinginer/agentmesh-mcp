import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const key = Buffer.alloc(32, 7).toString("base64url");

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
    });
    expect(config.signingKey).toEqual(Buffer.alloc(32, 7));
  });

  it("accepts an explicit bind address, port, and host allow-list", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://agentmesh:secret@postgres:5432/agentmesh",
      AGENT_SESSION_SIGNING_KEY: key,
      HOST: "0.0.0.0",
      PORT: "8080",
      ALLOWED_HOSTS: "agentmesh.example.com,localhost",
    });

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
      allowedHosts: ["agentmesh.example.com", "localhost"],
    });
  });

  it.each([
    { DATABASE_URL: "", AGENT_SESSION_SIGNING_KEY: key },
    { DATABASE_URL: "https://example.com", AGENT_SESSION_SIGNING_KEY: key },
    {
      DATABASE_URL: "postgres://agentmesh:secret@postgres:5432/agentmesh",
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
  ])("rejects unsafe or incomplete configuration", (environment) => {
    expect(() => loadConfig(environment)).toThrow("Invalid AgentMesh configuration");
  });
});

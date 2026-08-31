import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function productionConfig() {
  const output = execFileSync(
    "docker",
    ["compose", "-f", "deploy/compose.production.yaml", "config", "--format", "json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTMESH_IMAGE: "agentmesh:test",
        POSTGRES_PASSWORD: "synthetic-production-compose-password",
        AGENT_SESSION_SIGNING_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        AGENTMESH_ADMIN_TOKEN: "",
        GITHUB_OAUTH_CLIENT_ID: "synthetic-client-id",
        GITHUB_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
        GITHUB_OAUTH_CALLBACK_URL: "https://agentmesh.uzmedical.org/auth/github/callback",
        AGENTMESH_PUBLIC_ORIGIN: "https://agentmesh.uzmedical.org",
        AGENTMESH_ALLOWED_HOSTS: "agentmesh.uzmedical.org,127.0.0.1,localhost",
        AGENTMESH_WEB_AUTH_KEY: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        AGENTMESH_OPERATOR_GITHUB_IDS: "4242",
        AGENTMESH_PROJECT_LIMIT: "5",
        AGENTMESH_DB_OBSERVER_PASSWORD: "synthetic-observer-password-1234",
      },
    },
  );
  return JSON.parse(output) as {
    services: Record<string, {
      ports?: Array<{ host_ip?: string; published?: string; target?: number }>;
      read_only?: boolean;
      cap_drop?: string[];
      security_opt?: string[];
      networks?: Record<string, unknown>;
    }>;
    networks: Record<string, { internal?: boolean }>;
  };
}

describe("production deployment topology", () => {
  it("keeps the shared-host Caddy as the only public listener", () => {
    const compose = productionConfig();
    expect(compose.services.app?.ports).toEqual([
      expect.objectContaining({ host_ip: "127.0.0.1", published: "3100", target: 3000 }),
    ]);
    expect(compose.services.postgres?.ports).toEqual([
      expect.objectContaining({ host_ip: "127.0.0.1", published: "55433", target: 5432 }),
    ]);
    expect(compose.services.app?.read_only).toBe(true);
    expect(compose.services.app?.cap_drop).toContain("ALL");
    expect(compose.services.app?.security_opt).toContain("no-new-privileges:true");
    expect(compose.services.postgres?.networks).toEqual(
      expect.objectContaining({ backend: expect.anything(), observer: expect.anything() }),
    );
    expect(compose.networks.backend?.internal).toBe(true);
    expect(compose.networks.observer?.internal).not.toBe(true);
  });
});

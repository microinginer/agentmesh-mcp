import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createProjectToken,
  digestProjectToken,
  verifyProjectToken,
} from "../src/auth/project-token.js";
import {
  deriveAgentToken,
  digestRegistrationId,
  parseAgentToken,
  verifyAgentToken,
} from "../src/auth/agent-token.js";

const projectId = "78b43c09-c7bb-4114-b9f9-410e3dd9c7fe";
const otherProjectId = "d25281ea-a4b5-44fc-a500-3add55f5d4ea";
const agentId = "f4f74985-fc09-4c1f-ab7e-28871bc66dc9";
const sessionInstanceId = "1b55e221-63a7-41b0-940f-cb37e7d20e50";
const signingKey = Buffer.from("k".repeat(32), "utf8");

describe("project tokens", () => {
  it("creates a lookup ID plus a high-entropy secret and verifies only the full token", () => {
    const created = createProjectToken();

    expect(created.token).toMatch(
      /^am_proj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i,
    );
    expect(created.digest).toEqual(createHash("sha256").update(created.token).digest());
    expect(verifyProjectToken(created.token, created.digest)).toBe(true);

    const mutated = `${created.token.slice(0, -1)}${created.token.endsWith("A") ? "B" : "A"}`;
    expect(verifyProjectToken(mutated, created.digest)).toBe(false);
    expect(verifyProjectToken(created.token, Buffer.alloc(32, 1))).toBe(false);
  });

  it("extracts only a valid public lookup ID", () => {
    const created = createProjectToken();

    expect(created.tokenId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(digestProjectToken("not-a-token")).toBeNull();
  });
});

describe("agent tokens", () => {
  it("uses a stable domain-separated HMAC", () => {
    const token = deriveAgentToken({
      projectId,
      agentId,
      registrationDigest: Buffer.alloc(32),
      signingKey,
    });

    expect(token).toBe(
      "am_agent_f4f74985-fc09-4c1f-ab7e-28871bc66dc9.6uGdELEGbBcLSQOujGZysKmi7CoRhngRTVNytuqZkZQ",
    );
    expect(parseAgentToken(token)).toEqual({ agentId });
  });

  it("rejects mutation, another project, and another registration", () => {
    const registrationDigest = digestRegistrationId(projectId, sessionInstanceId);
    const token = deriveAgentToken({
      projectId,
      agentId,
      registrationDigest,
      signingKey,
    });

    expect(
      verifyAgentToken(token, { projectId, agentId, registrationDigest, signingKey }),
    ).toBe(true);
    expect(
      verifyAgentToken(token, {
        projectId: otherProjectId,
        agentId,
        registrationDigest,
        signingKey,
      }),
    ).toBe(false);
    expect(
      verifyAgentToken(token, {
        projectId,
        agentId,
        registrationDigest: Buffer.alloc(32, 7),
        signingKey,
      }),
    ).toBe(false);
    expect(verifyAgentToken(`${token.slice(0, -1)}A`, {
      projectId,
      agentId,
      registrationDigest,
      signingKey,
    })).toBe(false);
  });

  it("scopes registration digests to a project", () => {
    expect(digestRegistrationId(projectId, sessionInstanceId)).not.toEqual(
      digestRegistrationId(otherProjectId, sessionInstanceId),
    );
  });
});

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const agentTokenPattern =
  /^am_agent_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;

interface AgentTokenMaterial {
  projectId: string;
  agentId: string;
  registrationDigest: Buffer;
  signingKey: Buffer;
}

export function digestRegistrationId(projectId: string, sessionInstanceId: string): Buffer {
  return createHash("sha256")
    .update("agentmesh-registration-v1\0", "utf8")
    .update(projectId.toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(sessionInstanceId.toLowerCase(), "utf8")
    .digest();
}

export function deriveAgentToken(material: AgentTokenMaterial): string {
  if (material.signingKey.byteLength < 32) {
    throw new Error("Agent signing key must contain at least 32 bytes");
  }
  if (material.registrationDigest.byteLength !== 32) {
    throw new Error("Registration digest must contain exactly 32 bytes");
  }

  const normalizedAgentId = material.agentId.toLowerCase();
  const message = [
    "agentmesh-agent-v1",
    material.projectId.toLowerCase(),
    normalizedAgentId,
    material.registrationDigest.toString("hex"),
  ].join(":");
  const mac = createHmac("sha256", material.signingKey)
    .update(message, "utf8")
    .digest("base64url");

  return `am_agent_${normalizedAgentId}.${mac}`;
}

export function parseAgentToken(token: string): { agentId: string } | null {
  const match = agentTokenPattern.exec(token);
  const agentId = match?.[1];
  return agentId === undefined ? null : { agentId: agentId.toLowerCase() };
}

export function verifyAgentToken(token: string, material: AgentTokenMaterial): boolean {
  const parsed = parseAgentToken(token);
  if (parsed === null || parsed.agentId !== material.agentId.toLowerCase()) {
    return false;
  }

  const expected = deriveAgentToken(material);
  const actualBytes = Buffer.from(token, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

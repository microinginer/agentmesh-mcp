import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const projectTokenPattern =
  /^am_proj_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;

export interface CreatedProjectToken {
  tokenId: string;
  token: string;
  digest: Buffer;
}

export function createProjectToken(): CreatedProjectToken {
  const tokenId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `am_proj_${tokenId}.${secret}`;

  return {
    tokenId,
    token,
    digest: createHash("sha256").update(token, "utf8").digest(),
  };
}

export function parseProjectToken(token: string): { tokenId: string } | null {
  const match = projectTokenPattern.exec(token);
  const tokenId = match?.[1];
  return tokenId === undefined ? null : { tokenId: tokenId.toLowerCase() };
}

export function digestProjectToken(token: string): Buffer | null {
  if (parseProjectToken(token) === null) {
    return null;
  }

  return createHash("sha256").update(token, "utf8").digest();
}

export function verifyProjectToken(token: string, expectedDigest: Buffer): boolean {
  const actualDigest = digestProjectToken(token);
  if (actualDigest === null || expectedDigest.byteLength !== actualDigest.byteLength) {
    return false;
  }

  return timingSafeEqual(actualDigest, expectedDigest);
}

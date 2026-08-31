import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const OAUTH_COOKIE_VERSION = "v1";
const OAUTH_COOKIE_KEY_LABEL = "agentmesh-oauth-cookie-v1";
const OAUTH_COOKIE_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const OAUTH_COOKIE_MAX_LENGTH = 4_096;

export interface OAuthAttempt {
  state: string;
  verifier: string;
  expiresAt: number;
}

function validKey(key: Buffer): boolean {
  return key.byteLength === 32;
}

function canonicalBase64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function validAttempt(value: unknown): value is OAuthAttempt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const attempt = value as Partial<OAuthAttempt>;
  return (
    typeof attempt.state === "string" &&
    attempt.state.length > 0 &&
    attempt.state.length <= 512 &&
    typeof attempt.verifier === "string" &&
    attempt.verifier.length > 0 &&
    attempt.verifier.length <= 512 &&
    Number.isSafeInteger(attempt.expiresAt)
  );
}

export function deriveOAuthCookieKey(masterKey: Buffer): Buffer {
  if (!validKey(masterKey)) {
    throw new Error("Invalid OAuth attempt");
  }
  return createHmac("sha256", masterKey).update(OAUTH_COOKIE_KEY_LABEL, "utf8").digest();
}

export function sealOAuthAttempt(attempt: OAuthAttempt, masterKey: Buffer): string {
  if (!validAttempt(attempt)) {
    throw new Error("Invalid OAuth attempt");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveOAuthCookieKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(attempt), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [OAUTH_COOKIE_VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

export function openOAuthAttempt(value: string, masterKey: Buffer, now: Date): OAuthAttempt {
  try {
    if (value.length > OAUTH_COOKIE_MAX_LENGTH) {
      throw new Error();
    }
    const matched = OAUTH_COOKIE_PATTERN.exec(value);
    if (matched === null) {
      throw new Error();
    }
    const [, ivText, ciphertextText, tagText] = matched;
    if (ivText === undefined || ciphertextText === undefined || tagText === undefined) {
      throw new Error();
    }
    const iv = canonicalBase64url(ivText);
    const ciphertext = canonicalBase64url(ciphertextText);
    const tag = canonicalBase64url(tagText);
    if (iv?.byteLength !== 12 || ciphertext === null || tag?.byteLength !== 16) {
      throw new Error();
    }
    const decipher = createDecipheriv("aes-256-gcm", deriveOAuthCookieKey(masterKey), iv);
    decipher.setAuthTag(tag);
    const attempt = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as unknown;
    if (!validAttempt(attempt) || attempt.expiresAt <= now.getTime()) {
      throw new Error();
    }
    return attempt;
  } catch {
    throw new Error("Invalid OAuth attempt");
  }
}

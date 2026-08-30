import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE_NAME = "agentmesh_admin_session";
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

const SESSION_VERSION = "v1";
const SESSION_PATTERN = /^v1\.(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export interface AdminAuthConfig {
  tokenDigest: Buffer;
  sessionSigningKey: Buffer;
  secureCookies: boolean;
  clock?: () => Date;
}

export interface IssuedAdminSession {
  value: string;
  cookie: string;
}

export interface AdminAuth {
  verifyLogin: (token: string) => boolean;
  issueSession: () => IssuedAdminSession;
  verifySession: (value: string) => boolean;
}

function equalDigest(actual: Buffer, expected: Buffer): boolean {
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function sessionSignature(sessionSigningKey: Buffer, payload: string): Buffer {
  return createHmac("sha256", sessionSigningKey).update(payload, "utf8").digest();
}

function cookieAttributes(secureCookies: boolean, maxAge: number): string {
  return [
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    ...(secureCookies ? ["Secure"] : []),
  ].join("; ");
}

export function createSessionCookie(value: string, secureCookies: boolean): string {
  if (!SESSION_PATTERN.test(value)) {
    throw new Error("Invalid admin session");
  }
  return `${ADMIN_SESSION_COOKIE_NAME}=${value}; ${cookieAttributes(secureCookies, ADMIN_SESSION_TTL_MS / 1_000)}`;
}

export function clearSessionCookie(secureCookies: boolean): string {
  return `${ADMIN_SESSION_COOKIE_NAME}=; ${cookieAttributes(secureCookies, 0)}`;
}

export function parseAdminCookie(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined || cookieHeader.length > 4_096) {
    return null;
  }

  let value: string | null = null;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      if (entry.trim() === ADMIN_SESSION_COOKIE_NAME) {
        return null;
      }
      continue;
    }
    if (entry.slice(0, separator).trim() !== ADMIN_SESSION_COOKIE_NAME) {
      continue;
    }
    const candidate = entry.slice(separator + 1).trim();
    if (value !== null || !SESSION_PATTERN.test(candidate)) {
      return null;
    }
    value = candidate;
  }
  return value;
}

export function createAdminAuth(config: AdminAuthConfig): AdminAuth {
  const clock = config.clock ?? (() => new Date());

  return {
    verifyLogin(token: string): boolean {
      return equalDigest(createHash("sha256").update(token, "utf8").digest(), config.tokenDigest);
    },

    issueSession(): IssuedAdminSession {
      const expiresAt = clock().getTime() + ADMIN_SESSION_TTL_MS;
      const nonce = randomBytes(32).toString("base64url");
      const payload = `${SESSION_VERSION}.${expiresAt}.${nonce}`;
      const value = `${payload}.${sessionSignature(config.sessionSigningKey, payload).toString("base64url")}`;
      return { value, cookie: createSessionCookie(value, config.secureCookies) };
    },

    verifySession(value: string): boolean {
      const matched = SESSION_PATTERN.exec(value);
      if (matched === null) {
        return false;
      }

      const [, expiresAtText, nonce, signatureText] = matched;
      if (
        expiresAtText === undefined ||
        nonce === undefined ||
        signatureText === undefined
      ) {
        return false;
      }

      const expiresAt = Number(expiresAtText);
      const now = clock().getTime();
      if (
        !Number.isSafeInteger(expiresAt) ||
        !Number.isSafeInteger(now) ||
        expiresAt <= now ||
        expiresAt > now + ADMIN_SESSION_TTL_MS
      ) {
        return false;
      }

      const payload = `${SESSION_VERSION}.${expiresAtText}.${nonce}`;
      const expectedSignature = sessionSignature(config.sessionSigningKey, payload).toString("base64url");
      return equalDigest(Buffer.from(signatureText, "utf8"), Buffer.from(expectedSignature, "utf8"));
    },
  };
}

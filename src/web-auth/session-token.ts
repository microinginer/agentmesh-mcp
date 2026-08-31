import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { deriveOAuthCookieKey } from "./oauth-cookie.js";

const SESSION_DIGEST_KEY_LABEL = "agentmesh-session-digest-v1";
const CSRF_DIGEST_KEY_LABEL = "agentmesh-csrf-digest-v1";

export interface WebAuthKeys {
  oauthCookieKey: Buffer;
  sessionDigestKey: Buffer;
  csrfDigestKey: Buffer;
}

export interface SessionCredential {
  sessionToken: string;
  csrfToken: string;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
}

export interface CsrfCredential {
  csrfToken: string;
  csrfDigest: Buffer;
}

function deriveDigestKey(masterKey: Buffer, label: string): Buffer {
  if (masterKey.byteLength !== 32) {
    throw new Error("Invalid web auth key");
  }
  return createHmac("sha256", masterKey).update(label, "utf8").digest();
}

function digest(raw: string, key: Buffer): Buffer {
  if (key.byteLength !== 32) {
    throw new Error("Invalid web auth key");
  }
  return createHmac("sha256", key).update(raw, "utf8").digest();
}

function equalDigest(actual: Buffer, expected: Buffer): boolean {
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function deriveWebAuthKeys(masterKey: Buffer): WebAuthKeys {
  return {
    oauthCookieKey: deriveOAuthCookieKey(masterKey),
    sessionDigestKey: deriveDigestKey(masterKey, SESSION_DIGEST_KEY_LABEL),
    csrfDigestKey: deriveDigestKey(masterKey, CSRF_DIGEST_KEY_LABEL),
  };
}

export function digestSessionToken(raw: string, key: Buffer): Buffer {
  return digest(raw, key);
}

export function createSessionCredential(keys: Pick<WebAuthKeys, "sessionDigestKey" | "csrfDigestKey">): SessionCredential {
  const sessionToken = randomBytes(32).toString("base64url");
  const csrf = createCsrfCredential(keys);
  const credential = {} as SessionCredential;
  Object.defineProperties(credential, {
    sessionToken: { value: sessionToken, enumerable: false },
    csrfToken: { value: csrf.csrfToken, enumerable: false },
    sessionDigest: { value: digestSessionToken(sessionToken, keys.sessionDigestKey), enumerable: false },
    csrfDigest: { value: csrf.csrfDigest, enumerable: false },
  });
  return credential;
}

export function createCsrfCredential(keys: Pick<WebAuthKeys, "csrfDigestKey">): CsrfCredential {
  const csrfToken = randomBytes(32).toString("base64url");
  const credential = {} as CsrfCredential;
  Object.defineProperties(credential, {
    csrfToken: { value: csrfToken, enumerable: false },
    csrfDigest: { value: digest(csrfToken, keys.csrfDigestKey), enumerable: false },
  });
  return credential;
}

export function verifyCsrfToken(raw: string, digestValue: Buffer, key: Buffer): boolean {
  return equalDigest(digest(raw, key), digestValue);
}

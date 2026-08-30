import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ADMIN_SESSION_TTL_MS,
  ADMIN_SESSION_COOKIE_NAME,
  clearSessionCookie,
  createAdminAuth,
  createSessionCookie,
  parseAdminCookie,
} from "../src/admin/auth.js";

const now = new Date("2026-08-30T12:00:00.000Z");
const rawAdminToken = Buffer.alloc(32, 9).toString("base64url");
const serverSigningKey = Buffer.alloc(32, 7);
const sessionSigningKey = createHmac("sha256", serverSigningKey)
  .update("agentmesh-admin-session-v1")
  .digest();

function createAuth(clock: () => Date = () => now) {
  return createAdminAuth({
    tokenDigest: createHash("sha256").update(rawAdminToken).digest(),
    sessionSigningKey,
    secureCookies: false,
    clock,
  });
}

describe("local admin authentication", () => {
  it("accepts only the configured administrator token", () => {
    const auth = createAuth();

    expect(auth.verifyLogin(rawAdminToken)).toBe(true);
    expect(auth.verifyLogin(Buffer.alloc(32, 8).toString("base64url"))).toBe(false);
  });

  it("issues a signed, nonce-bearing session cookie without the administrator token", () => {
    const auth = createAuth();
    const session = auth.issueSession();

    expect(session.value).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(session.cookie).toContain(`${ADMIN_SESSION_COOKIE_NAME}=${session.value}`);
    expect(session.cookie).toContain("HttpOnly");
    expect(session.cookie).toContain("SameSite=Strict");
    expect(session.cookie).toContain("Path=/");
    expect(session.cookie).toContain(`Max-Age=${ADMIN_SESSION_TTL_MS / 1_000}`);
    expect(session.cookie).not.toContain("Secure");
    expect(session.cookie).not.toContain(rawAdminToken);
    expect(auth.verifySession(session.value)).toBe(true);
  });

  it("rejects malformed, expired, future-skewed, and mutated sessions", () => {
    const auth = createAuth();
    const session = auth.issueSession();
    const [version, , nonce] = session.value.split(".");
    const sign = (expiry: number) => {
      const payload = `${version}.${expiry}.${nonce}`;
      return `${payload}.${createHmac("sha256", sessionSigningKey).update(payload).digest("base64url")}`;
    };

    expect(auth.verifySession("v1.not-a-time.nonce.signature")).toBe(false);
    expect(auth.verifySession(sign(now.getTime()))).toBe(false);
    expect(auth.verifySession(sign(now.getTime() + ADMIN_SESSION_TTL_MS + 1))).toBe(false);
    const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const signature = session.value.split(".").at(-1);
    expect(signature).toBeDefined();
    const signatureIndex = base64urlAlphabet.indexOf(signature?.at(-1) ?? "");
    const equivalentNonCanonicalLastCharacter = base64urlAlphabet[signatureIndex ^ 1];
    const nonCanonicalSession = `${session.value.slice(0, -1)}${equivalentNonCanonicalLastCharacter}`;

    expect(Buffer.from(nonCanonicalSession.split(".").at(-1) ?? "", "base64url")).toEqual(
      Buffer.from(signature ?? "", "base64url"),
    );
    expect(auth.verifySession(nonCanonicalSession)).toBe(false);
  });

  it("parses one well-formed session cookie and creates secure cookie attributes when requested", () => {
    const value = "v1.1788084800000.abc_def.signature";

    expect(parseAdminCookie(`theme=dark; ${ADMIN_SESSION_COOKIE_NAME}=${value}`)).toBe(value);
    expect(parseAdminCookie(`${ADMIN_SESSION_COOKIE_NAME}=one; ${ADMIN_SESSION_COOKIE_NAME}=two`)).toBeNull();
    expect(parseAdminCookie(`${ADMIN_SESSION_COOKIE_NAME}=`)).toBeNull();
    expect(parseAdminCookie(`${ADMIN_SESSION_COOKIE_NAME}; ${ADMIN_SESSION_COOKIE_NAME}=${value}`)).toBeNull();
    expect(createSessionCookie(value, true)).toContain("Secure");
    expect(clearSessionCookie(true)).toContain("Max-Age=0");
    expect(clearSessionCookie(true)).toContain("Secure");
  });
});

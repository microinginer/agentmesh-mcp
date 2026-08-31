import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { openOAuthAttempt, sealOAuthAttempt } from "../src/web-auth/oauth-cookie.js";
import {
  createSessionCredential,
  deriveWebAuthKeys,
  digestSessionToken,
  verifyCsrfToken,
} from "../src/web-auth/session-token.js";

const masterKey = Buffer.alloc(32, 8);

describe("hosted web credential primitives", () => {
  it("seals OAuth state with authenticated encryption and rejects tampering or expiry", () => {
    const attempt = { state: "state-value", verifier: "pkce-verifier", expiresAt: 1_000 };
    const sealed = sealOAuthAttempt(attempt, masterKey);

    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(attempt.state);
    expect(sealed).not.toContain(attempt.verifier);
    expect(openOAuthAttempt(sealed, masterKey, new Date(999))).toEqual(attempt);
    expect(() => openOAuthAttempt(`${sealed}x`, masterKey, new Date(999))).toThrow("Invalid OAuth attempt");
    expect(() => openOAuthAttempt(sealed, masterKey, new Date(1_000))).toThrow("Invalid OAuth attempt");
    expect(() => openOAuthAttempt(sealed, masterKey, new Date("invalid"))).toThrow("Invalid OAuth attempt");
  });

  it("rejects malformed, noncanonical, and incorrectly sized OAuth cookie segments", () => {
    const sealed = sealOAuthAttempt({ state: "state-value", verifier: "pkce-verifier", expiresAt: 1_000 }, masterKey);
    const [version, iv, ciphertext, tag] = sealed.split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const tagLastCharacter = tag?.at(-1);
    const tagIndex = alphabet.indexOf(tagLastCharacter ?? "");
    const noncanonicalTag = `${tag?.slice(0, -1)}${alphabet[tagIndex ^ 1]}`;

    expect(version).toBe("v1");
    expect(iv).toBeDefined();
    expect(ciphertext).toBeDefined();
    expect(tag).toBeDefined();
    expect(Buffer.from(noncanonicalTag, "base64url")).toEqual(Buffer.from(tag ?? "", "base64url"));
    expect(() => openOAuthAttempt(`${version}.${iv}.${ciphertext}`, masterKey, new Date(999))).toThrow("Invalid OAuth attempt");
    expect(() => openOAuthAttempt(`${version}.${iv}.${ciphertext}.${tag}.extra`, masterKey, new Date(999))).toThrow("Invalid OAuth attempt");
    expect(() => openOAuthAttempt(`${version}.AA.${ciphertext}.${tag}`, masterKey, new Date(999))).toThrow("Invalid OAuth attempt");
    expect(() => openOAuthAttempt(`${version}.${Buffer.alloc(13).toString("base64url")}.${ciphertext}.${tag}`, masterKey, new Date(999))).toThrow("Invalid OAuth attempt");
    expect(() => openOAuthAttempt(`${version}.${iv}.${ciphertext}.${Buffer.alloc(15).toString("base64url")}`, masterKey, new Date(999))).toThrow("Invalid OAuth attempt");
    expect(() => openOAuthAttempt(`${version}.${iv}.${ciphertext}.${Buffer.alloc(17).toString("base64url")}`, masterKey, new Date(999))).toThrow("Invalid OAuth attempt");
    expect(() => openOAuthAttempt(`${version}.${iv}.${ciphertext}.${noncanonicalTag}`, masterKey, new Date(999))).toThrow("Invalid OAuth attempt");
  });

  it("uses a fresh OAuth IV for each sealed attempt", () => {
    const attempt = { state: "state-value", verifier: "pkce-verifier", expiresAt: 1_000 };

    expect(sealOAuthAttempt(attempt, masterKey)).not.toBe(sealOAuthAttempt(attempt, masterKey));
  });

  it("derives independent credential keys and keeps all credential material out of serialization", () => {
    const keys = deriveWebAuthKeys(masterKey);
    const credential = createSessionCredential(keys);

    expect(keys.oauthCookieKey).toEqual(
      createHmac("sha256", masterKey).update("agentmesh-oauth-cookie-v1", "utf8").digest(),
    );
    expect(keys.sessionDigestKey).toEqual(
      createHmac("sha256", masterKey).update("agentmesh-session-digest-v1", "utf8").digest(),
    );
    expect(keys.csrfDigestKey).toEqual(
      createHmac("sha256", masterKey).update("agentmesh-csrf-digest-v1", "utf8").digest(),
    );
    expect(credential.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credential.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credential.sessionToken).not.toBe(credential.csrfToken);
    expect(credential.sessionDigest).toEqual(digestSessionToken(credential.sessionToken, keys.sessionDigestKey));
    expect(credential.csrfDigest).not.toEqual(digestSessionToken(credential.csrfToken, keys.sessionDigestKey));
    expect(JSON.stringify(credential)).toBe("{}");
    expect({ ...credential }).toEqual({});
  });

  it("accepts only the matching CSRF secret and digest", () => {
    const keys = deriveWebAuthKeys(masterKey);
    const credential = createSessionCredential(keys);

    expect(verifyCsrfToken(credential.csrfToken, credential.csrfDigest, keys.csrfDigestKey)).toBe(true);
    expect(verifyCsrfToken(`${credential.csrfToken}x`, credential.csrfDigest, keys.csrfDigestKey)).toBe(false);
    expect(verifyCsrfToken(credential.csrfToken, credential.csrfDigest, keys.sessionDigestKey)).toBe(false);
    expect(verifyCsrfToken(credential.csrfToken, Buffer.alloc(31), keys.csrfDigestKey)).toBe(false);
    expect(verifyCsrfToken(credential.csrfToken, Buffer.alloc(33), keys.csrfDigestKey)).toBe(false);
  });
});

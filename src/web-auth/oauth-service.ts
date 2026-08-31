import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AuditService } from "../audit/service.js";
import type { GitHubOAuthClient } from "./github-client.js";
import type { IdentityService } from "./identity-service.js";
import { openOAuthAttempt, sealOAuthAttempt } from "./oauth-cookie.js";
import {
  isCanonicalWebCredential,
  type AuthenticatedWebSession,
  type IssuedWebSession,
  type WebSessionService,
} from "./session-service.js";

const OAUTH_ATTEMPT_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_CONSUMED_ATTEMPTS = 1_024;

export interface OAuthService {
  start(returnTo: string): { authorizationUrl: URL; attemptCookie: string } | null;
  complete(input: {
    attemptCookie: string;
    code: string;
    state: string;
    currentSession: AuthenticatedWebSession | null;
  }): Promise<{ session: IssuedWebSession; returnTo: string } | null>;
}

interface OAuthServiceDependencies {
  oauthClient: GitHubOAuthClient;
  identityService: IdentityService;
  sessionService: WebSessionService;
  auditService: AuditService;
  oauthCookieKey: Buffer;
  clock?: () => Date;
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function sameState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

export function createOAuthService(dependencies: OAuthServiceDependencies): OAuthService {
  const clock = dependencies.clock ?? (() => new Date());
  const consumedAttempts = new Map<string, number>();

  async function failed(): Promise<null> {
    await dependencies.auditService.recordBestEffort({
      userId: null,
      eventType: "auth.login_failed",
      metadata: { provider: "github" },
    });
    return null;
  }

  function consumeAttempt(cookie: string, expiresAt: number, now: Date): boolean {
    const nowMilliseconds = now.getTime();
    if (!Number.isFinite(nowMilliseconds)) return false;
    for (const [fingerprint, expiry] of consumedAttempts) {
      if (expiry <= nowMilliseconds) consumedAttempts.delete(fingerprint);
    }
    const fingerprint = createHmac("sha256", dependencies.oauthCookieKey).update(cookie, "utf8").digest("base64url");
    if (consumedAttempts.has(fingerprint)) return false;
    consumedAttempts.set(fingerprint, expiresAt);
    while (consumedAttempts.size > MAX_CONSUMED_ATTEMPTS) {
      const oldest = consumedAttempts.keys().next().value;
      if (oldest === undefined) break;
      consumedAttempts.delete(oldest);
    }
    return true;
  }

  function start(returnTo: string): { authorizationUrl: URL; attemptCookie: string } | null {
    const now = clock();
    if (!validDate(now)) return null;
    const expiresAt = now.getTime() + OAUTH_ATTEMPT_LIFETIME_MS;
    if (!Number.isSafeInteger(expiresAt)) return null;
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
    return {
      authorizationUrl: dependencies.oauthClient.authorizationUrl(state, challenge),
      attemptCookie: sealOAuthAttempt({ state, verifier, expiresAt, returnTo }, dependencies.oauthCookieKey),
    };
  }

  async function complete(input: {
    attemptCookie: string;
    code: string;
    state: string;
    currentSession: AuthenticatedWebSession | null;
  }): Promise<{ session: IssuedWebSession; returnTo: string } | null> {
    let accessToken: string | null = null;
    try {
      if (!isCanonicalWebCredential(input.state)) return failed();
      const now = clock();
      const attempt = openOAuthAttempt(input.attemptCookie, dependencies.oauthCookieKey, now);
      if (!consumeAttempt(input.attemptCookie, attempt.expiresAt, now)) return failed();
      if (!sameState(input.state, attempt.state)) return failed();

      accessToken = await dependencies.oauthClient.exchangeCode(input.code, attempt.verifier);
      const profile = await dependencies.oauthClient.fetchProfile(accessToken);
      if (input.currentSession !== null && input.currentSession.githubUserId !== profile.id) {
        return failed();
      }

      const identity = await dependencies.identityService.upsertGitHub(profile);
      const session = input.currentSession === null
        ? await dependencies.sessionService.issue(identity.userId)
        : await dependencies.sessionService.rotateForReauthentication(
          input.currentSession.sessionId,
          identity.userId,
        );
      if (session === null) return failed();
      return { session, returnTo: attempt.returnTo ?? "/app" };
    } catch {
      return failed();
    } finally {
      accessToken = null;
    }
  }

  return { start, complete };
}

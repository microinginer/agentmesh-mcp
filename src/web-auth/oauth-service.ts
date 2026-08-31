import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, gt, inArray, isNull, sql } from "drizzle-orm";

import type { AuditService } from "../audit/service.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { oauthAttempts } from "../db/schema.js";
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
const EXPIRED_ATTEMPT_CLEANUP_LIMIT = 128;

export interface OAuthService {
  start(returnTo: string): Promise<{ authorizationUrl: URL; attemptCookie: string } | null>;
  consume(attemptCookies: readonly string[]): Promise<Array<OAuthAttempt | null>>;
  complete(input: {
    attempt: OAuthAttempt;
    code: string;
    state: string;
    currentSession: AuthenticatedWebSession | null;
  }): Promise<{ session: IssuedWebSession; returnTo: string } | null>;
}

interface OAuthServiceDependencies {
  db: AgentMeshDatabase;
  oauthClient: GitHubOAuthClient;
  identityService: IdentityService;
  sessionService: WebSessionService;
  auditService: AuditService;
  oauthCookieKey: Buffer;
  clock?: () => Date;
}

interface OAuthAttempt {
  state: string;
  verifier: string;
  expiresAt: number;
  returnTo?: string;
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

  async function failed(): Promise<null> {
    await dependencies.auditService.recordBestEffort({
      userId: null,
      eventType: "auth.login_failed",
      metadata: { provider: "github" },
    });
    return null;
  }

  function attemptDigest(cookie: string): Buffer {
    return createHmac("sha256", dependencies.oauthCookieKey).update(cookie, "utf8").digest();
  }

  async function start(returnTo: string): Promise<{ authorizationUrl: URL; attemptCookie: string } | null> {
    const now = clock();
    if (!validDate(now)) return null;
    const expiresAt = now.getTime() + OAUTH_ATTEMPT_LIFETIME_MS;
    if (!Number.isSafeInteger(expiresAt)) return null;
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
    const attemptCookie = sealOAuthAttempt({ state, verifier, expiresAt, returnTo }, dependencies.oauthCookieKey);
    try {
      await dependencies.db.transaction(async (transaction) => {
        await transaction.execute(sql`
          WITH expired AS (
            SELECT ctid
            FROM ${oauthAttempts}
            WHERE ${oauthAttempts.expiresAt} <= ${now}
            ORDER BY ${oauthAttempts.expiresAt} ASC
            LIMIT ${EXPIRED_ATTEMPT_CLEANUP_LIMIT}
          )
          DELETE FROM ${oauthAttempts}
          WHERE ctid IN (SELECT ctid FROM expired)
        `);
        await transaction.insert(oauthAttempts).values({
          attemptDigest: attemptDigest(attemptCookie),
          expiresAt: new Date(expiresAt),
          createdAt: now,
        });
      });
    } catch {
      return null;
    }
    return { authorizationUrl: dependencies.oauthClient.authorizationUrl(state, challenge), attemptCookie };
  }

  async function consume(attemptCookies: readonly string[]): Promise<Array<OAuthAttempt | null>> {
    if (attemptCookies.length === 0) return [];
    const now = clock();
    if (!validDate(now)) return attemptCookies.map(() => null);
    const candidates = attemptCookies.map((cookie) => {
      const digest = attemptDigest(cookie);
      return { cookie, digest, digestKey: digest.toString("hex") };
    });
    const uniqueDigests = [...new Map(candidates.map((candidate) => [
      candidate.digestKey,
      candidate.digest,
    ])).values()];
    try {
      const marked = await dependencies.db.transaction(async (transaction) => {
        return transaction
          .update(oauthAttempts)
          .set({ consumedAt: now })
          .where(and(
            inArray(oauthAttempts.attemptDigest, uniqueDigests),
            gt(oauthAttempts.expiresAt, now),
            isNull(oauthAttempts.consumedAt),
          ))
          .returning({
            attemptDigest: oauthAttempts.attemptDigest,
            expiresAt: oauthAttempts.expiresAt,
          });
      });
      const markedByDigest = new Map(marked.map((row) => [
        row.attemptDigest.toString("hex"),
        row.expiresAt,
      ]));
      return candidates.map((candidate) => {
        const markedExpiresAt = markedByDigest.get(candidate.digestKey);
        if (markedExpiresAt === undefined) return null;
        try {
          const attempt = openOAuthAttempt(candidate.cookie, dependencies.oauthCookieKey, now);
          return attempt.expiresAt === markedExpiresAt.getTime() ? attempt : null;
        } catch {
          return null;
        }
      });
    } catch {
      return attemptCookies.map(() => null);
    }
  }

  async function complete(input: {
    attempt: OAuthAttempt;
    code: string;
    state: string;
    currentSession: AuthenticatedWebSession | null;
  }): Promise<{ session: IssuedWebSession; returnTo: string } | null> {
    let accessToken: string | null = null;
    try {
      if (!isCanonicalWebCredential(input.state)) return failed();
      if (!sameState(input.state, input.attempt.state)) return failed();

      accessToken = await dependencies.oauthClient.exchangeCode(input.code, input.attempt.verifier);
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
      await dependencies.auditService.recordBestEffort({
        userId: identity.userId,
        eventType: "auth.login_succeeded",
        metadata: { provider: "github" },
      });
      return { session, returnTo: input.attempt.returnTo ?? "/app" };
    } catch {
      return failed();
    } finally {
      accessToken = null;
    }
  }

  return { start, consume, complete };
}

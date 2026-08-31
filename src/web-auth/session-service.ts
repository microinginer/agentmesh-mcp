import { and, eq, gt, isNull } from "drizzle-orm";

import type { AgentMeshDatabase } from "../db/client.js";
import { oauthIdentities, users, webSessions } from "../db/schema.js";
import {
  createSessionCredential,
  digestSessionToken,
  verifyCsrfToken,
  type WebAuthKeys,
} from "./session-token.js";

const GITHUB_PROVIDER = "github";
const IDLE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1_000;

export interface AuthenticatedWebSession {
  sessionId: string;
  userId: string;
  githubUserId: string;
  githubLogin: string;
  displayName: string;
  avatarUrl: string | null;
  authenticatedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  csrfDigest: Buffer;
}

export interface IssuedWebSession {
  sessionId: string;
  authenticatedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  sessionToken: string;
  csrfToken: string;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
}

export interface WebSessionService {
  issue(userId: string, authenticatedAt?: Date): Promise<IssuedWebSession | null>;
  authenticate(sessionToken: string): Promise<AuthenticatedWebSession | null>;
  verifyCsrf(csrfToken: string, csrfDigest: Buffer): boolean;
  revoke(sessionId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

export class WebSessionServiceUnavailableError extends Error {
  constructor() {
    super("Web session service unavailable");
    this.name = "WebSessionServiceUnavailableError";
  }
}

interface WebSessionServiceDependencies {
  db: AgentMeshDatabase;
  keys: Pick<WebAuthKeys, "sessionDigestKey" | "csrfDigestKey">;
  clock?: () => Date;
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function minimumDate(first: Date, second: Date): Date {
  return first.getTime() <= second.getTime() ? first : second;
}

/** A browser credential is exactly 32 random bytes in canonical base64url form. */
export function isCanonicalWebCredential(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function authenticatedSnapshot(row: {
  sessionId: string;
  userId: string;
  githubUserId: string;
  githubLogin: string;
  displayName: string;
  avatarUrl: string | null;
  authenticatedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  csrfDigest: Buffer;
}): AuthenticatedWebSession {
  const session = {
    sessionId: row.sessionId,
    userId: row.userId,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    authenticatedAt: cloneDate(row.authenticatedAt),
    idleExpiresAt: cloneDate(row.idleExpiresAt),
    absoluteExpiresAt: cloneDate(row.absoluteExpiresAt),
  } as AuthenticatedWebSession;
  Object.defineProperty(session, "csrfDigest", {
    value: Buffer.from(row.csrfDigest),
    enumerable: false,
  });
  return session;
}

function issuedSession(row: {
  sessionId: string;
  authenticatedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}, credential: ReturnType<typeof createSessionCredential>): IssuedWebSession {
  const issued = {
    sessionId: row.sessionId,
    authenticatedAt: cloneDate(row.authenticatedAt),
    idleExpiresAt: cloneDate(row.idleExpiresAt),
    absoluteExpiresAt: cloneDate(row.absoluteExpiresAt),
  } as IssuedWebSession;
  Object.defineProperties(issued, {
    sessionToken: { value: credential.sessionToken, enumerable: false },
    csrfToken: { value: credential.csrfToken, enumerable: false },
    sessionDigest: { value: Buffer.from(credential.sessionDigest), enumerable: false },
    csrfDigest: { value: Buffer.from(credential.csrfDigest), enumerable: false },
  });
  return issued;
}

export function createWebSessionService(dependencies: WebSessionServiceDependencies): WebSessionService {
  const clock = dependencies.clock ?? (() => new Date());

  async function issue(userId: string, authenticatedAt = clock()): Promise<IssuedWebSession | null> {
    const now = cloneDate(authenticatedAt);
    if (!isValidDate(now)) {
      return null;
    }
    const credential = createSessionCredential(dependencies.keys);
    const absoluteExpiresAt = addMilliseconds(now, ABSOLUTE_LIFETIME_MS);
    const requestedIdleExpiry = addMilliseconds(now, IDLE_LIFETIME_MS);
    if (!isValidDate(absoluteExpiresAt) || !isValidDate(requestedIdleExpiry)) {
      return null;
    }
    const idleExpiresAt = minimumDate(requestedIdleExpiry, absoluteExpiresAt);

    return dependencies.db.transaction(async (transaction) => {
      const [user] = await transaction
        .select({ id: users.id, blockedAt: users.blockedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (user === undefined || user.blockedAt !== null) {
        return null;
      }

      const [created] = await transaction.insert(webSessions).values({
        userId,
        tokenDigest: credential.sessionDigest,
        csrfDigest: credential.csrfDigest,
        authenticatedAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
      }).returning({ id: webSessions.id });
      if (created === undefined) {
        throw new Error("Web session creation did not return a session ID");
      }
      return issuedSession({
        sessionId: created.id,
        authenticatedAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
      }, credential);
    });
  }

  async function authenticate(sessionToken: string): Promise<AuthenticatedWebSession | null> {
    if (!isCanonicalWebCredential(sessionToken)) {
      return null;
    }
    const now = cloneDate(clock());
    if (!isValidDate(now)) {
      return null;
    }
    const tokenDigest = digestSessionToken(sessionToken, dependencies.keys.sessionDigestKey);

    return dependencies.db.transaction(async (transaction) => {
      const [row] = await transaction.select({
        sessionId: webSessions.id,
        userId: webSessions.userId,
        csrfDigest: webSessions.csrfDigest,
        authenticatedAt: webSessions.authenticatedAt,
        lastSeenAt: webSessions.lastSeenAt,
        idleExpiresAt: webSessions.idleExpiresAt,
        absoluteExpiresAt: webSessions.absoluteExpiresAt,
        revokedAt: webSessions.revokedAt,
        blockedAt: users.blockedAt,
        githubUserId: oauthIdentities.providerUserId,
        githubLogin: oauthIdentities.login,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      }).from(webSessions)
        .innerJoin(users, eq(users.id, webSessions.userId))
        .innerJoin(oauthIdentities, and(
          eq(oauthIdentities.userId, users.id),
          eq(oauthIdentities.provider, GITHUB_PROVIDER),
        ))
        .where(eq(webSessions.tokenDigest, tokenDigest))
        .limit(1)
        .for("update");
      if (row === undefined || row.revokedAt !== null || row.blockedAt !== null) {
        return null;
      }
      if (!isValidDate(row.authenticatedAt) || !isValidDate(row.lastSeenAt)
        || !isValidDate(row.idleExpiresAt) || !isValidDate(row.absoluteExpiresAt)
        || now.getTime() < row.authenticatedAt.getTime() || now.getTime() < row.lastSeenAt.getTime()
        || now.getTime() >= row.idleExpiresAt.getTime() || now.getTime() >= row.absoluteExpiresAt.getTime()) {
        return null;
      }

      let idleExpiresAt = row.idleExpiresAt;
      if (now.getTime() - row.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
        const nextIdleExpiry = minimumDate(addMilliseconds(now, IDLE_LIFETIME_MS), row.absoluteExpiresAt);
        const [updated] = await transaction.update(webSessions).set({
          lastSeenAt: now,
          idleExpiresAt: nextIdleExpiry,
        }).where(and(
          eq(webSessions.id, row.sessionId),
          eq(webSessions.tokenDigest, tokenDigest),
          isNull(webSessions.revokedAt),
          gt(webSessions.idleExpiresAt, now),
          gt(webSessions.absoluteExpiresAt, now),
        )).returning({ idleExpiresAt: webSessions.idleExpiresAt });
        if (updated === undefined) {
          return null;
        }
        idleExpiresAt = updated.idleExpiresAt;
      }

      return authenticatedSnapshot({ ...row, idleExpiresAt });
    });
  }

  async function revoke(sessionId: string): Promise<void> {
    const now = cloneDate(clock());
    if (!isValidDate(now)) {
      throw new WebSessionServiceUnavailableError();
    }
    await dependencies.db.transaction(async (transaction) => {
      await transaction.update(webSessions).set({ revokedAt: now }).where(and(
        eq(webSessions.id, sessionId),
        isNull(webSessions.revokedAt),
      ));
    });
  }

  async function revokeAllForUser(userId: string): Promise<void> {
    const now = cloneDate(clock());
    if (!isValidDate(now)) {
      throw new WebSessionServiceUnavailableError();
    }
    await dependencies.db.transaction(async (transaction) => {
      await transaction.update(webSessions).set({ revokedAt: now }).where(and(
        eq(webSessions.userId, userId),
        isNull(webSessions.revokedAt),
      ));
    });
  }

  function verifyCsrf(csrfToken: string, csrfDigest: Buffer): boolean {
    return isCanonicalWebCredential(csrfToken)
      && verifyCsrfToken(csrfToken, csrfDigest, dependencies.keys.csrfDigestKey);
  }

  return { issue, authenticate, verifyCsrf, revoke, revokeAllForUser };
}

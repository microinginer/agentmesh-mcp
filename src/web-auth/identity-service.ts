import { and, eq, sql } from "drizzle-orm";

import type { AgentMeshDatabase } from "../db/client.js";
import { oauthIdentities, users } from "../db/schema.js";
import type { GitHubProfile } from "./github-client.js";

const GITHUB_PROVIDER = "github";

interface IdentityServiceDependencies {
  db: AgentMeshDatabase;
  clock?: () => Date;
}

export interface GitHubIdentity {
  userId: string;
}

function displayName(profile: GitHubProfile): string {
  return profile.name ?? profile.login;
}

type SnapshotExecutor = Pick<AgentMeshDatabase, "update">;

export function createIdentityService(dependencies: IdentityServiceDependencies) {
  const { db } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function applyProfileSnapshots(
    executor: SnapshotExecutor,
    userId: string,
    profile: GitHubProfile,
    now: Date,
  ): Promise<void> {
    await executor
      .update(users)
      .set({
        displayName: displayName(profile),
        avatarUrl: profile.avatarUrl,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
    await executor
      .update(oauthIdentities)
      .set({ login: profile.login, updatedAt: now, lastLoginAt: now })
      .where(and(
        eq(oauthIdentities.provider, GITHUB_PROVIDER),
        eq(oauthIdentities.providerUserId, profile.id),
      ));
  }

  async function upsertGitHub(profile: GitHubProfile): Promise<GitHubIdentity> {
    const now = clock();
    return db.transaction(async (transaction) => {
        // Serialize every immutable provider identity before allocating its local user.
        // The transaction-scoped PostgreSQL advisory lock prevents a losing callback
        // from leaving behind a user row after the identity uniqueness race.
        await transaction.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${`${GITHUB_PROVIDER}:${profile.id}`}, 0))
        `);

        const [existing] = await transaction
          .select({ userId: oauthIdentities.userId })
          .from(oauthIdentities)
          .where(and(
            eq(oauthIdentities.provider, GITHUB_PROVIDER),
            eq(oauthIdentities.providerUserId, profile.id),
          ))
          .limit(1);

        let userId: string;
        if (existing !== undefined) {
          userId = existing.userId;
        } else {
          const [createdUser] = await transaction
            .insert(users)
            .values({
              displayName: displayName(profile),
              avatarUrl: profile.avatarUrl,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: users.id });
          if (createdUser === undefined) {
            throw new Error("GitHub user creation did not return a local user");
          }

          const [createdIdentity] = await transaction
            .insert(oauthIdentities)
            .values({
              userId: createdUser.id,
              provider: GITHUB_PROVIDER,
              providerUserId: profile.id,
              login: profile.login,
              createdAt: now,
              updatedAt: now,
              lastLoginAt: now,
            })
            .onConflictDoNothing({
              target: [oauthIdentities.provider, oauthIdentities.providerUserId],
            })
            .returning({ userId: oauthIdentities.userId });

          if (createdIdentity !== undefined) {
            userId = createdIdentity.userId;
          } else {
            const [conflictingIdentity] = await transaction
              .select({ userId: oauthIdentities.userId })
              .from(oauthIdentities)
              .where(and(
                eq(oauthIdentities.provider, GITHUB_PROVIDER),
                eq(oauthIdentities.providerUserId, profile.id),
              ))
              .limit(1);
            if (conflictingIdentity === undefined) {
              throw new Error("GitHub identity conflict row disappeared");
            }
            await transaction.delete(users).where(eq(users.id, createdUser.id));
            userId = conflictingIdentity.userId;
          }
        }

        await applyProfileSnapshots(transaction, userId, profile, now);

        return { userId };
      });
  }

  return { upsertGitHub };
}

export type IdentityService = ReturnType<typeof createIdentityService>;

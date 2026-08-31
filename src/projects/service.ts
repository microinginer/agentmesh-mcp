import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  createProjectToken,
  parseProjectToken,
  verifyProjectToken,
} from "../auth/project-token.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { projectTokens, projects, users } from "../db/schema.js";
import { AgentMeshError } from "../errors.js";

interface ProjectServiceDependencies {
  db: AgentMeshDatabase;
  clock?: () => Date;
}

export interface AuthenticatedProject {
  projectId: string;
  connectionTokenId: string;
}

function projectAuthInvalid(): AgentMeshError {
  return new AgentMeshError("PROJECT_AUTH_INVALID", "Project authentication failed");
}

export function createProjectService(dependencies: ProjectServiceDependencies) {
  const { db } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function createProject(name: string) {
    const id = randomUUID();
    const createdAt = new Date();
    const token = createProjectToken();

    await db.transaction(async (transaction) => {
      await transaction.insert(projects).values({ id, name, createdAt });
      await transaction.insert(projectTokens).values({
        id: token.tokenId,
        projectId: id,
        tokenDigest: token.digest,
        label: "Legacy CLI token",
        createdAt,
      });
    });

    return {
      project: {
        id,
        name,
        created_at: createdAt.toISOString(),
      },
      token_id: token.tokenId,
      token: token.token,
    };
  }

  async function authenticateProject(token: string): Promise<AuthenticatedProject> {
    const parsed = parseProjectToken(token);
    if (parsed === null) {
      throw projectAuthInvalid();
    }

    const [preflight] = await db
      .select({ projectId: projectTokens.projectId, tokenDigest: projectTokens.tokenDigest })
      .from(projectTokens)
      .where(eq(projectTokens.id, parsed.tokenId))
      .limit(1);
    if (preflight === undefined || !verifyProjectToken(token, preflight.tokenDigest)) {
      throw projectAuthInvalid();
    }

    return db.transaction(async (transaction) => {
      const [project] = await transaction.select({
        id: projects.id,
        ownerUserId: projects.ownerUserId,
        status: projects.status,
      }).from(projects).where(eq(projects.id, preflight.projectId)).limit(1).for("update");
      if (project === undefined || project.status !== "active") throw projectAuthInvalid();

      const [stored] = await transaction.select({
        id: projectTokens.id,
        projectId: projectTokens.projectId,
        tokenDigest: projectTokens.tokenDigest,
        expiresAt: projectTokens.expiresAt,
        revokedAt: projectTokens.revokedAt,
      }).from(projectTokens).where(and(
        eq(projectTokens.projectId, project.id),
        eq(projectTokens.id, parsed.tokenId),
      )).limit(1).for("update");
      const now = clock();
      if (
        stored === undefined
        || !Number.isFinite(now.getTime())
        || stored.revokedAt !== null
        || (stored.expiresAt !== null && stored.expiresAt.getTime() <= now.getTime())
        || !verifyProjectToken(token, stored.tokenDigest)
      ) {
        throw projectAuthInvalid();
      }

      if (project.ownerUserId !== null) {
        const [owner] = await transaction.select({ blockedAt: users.blockedAt }).from(users)
          .where(eq(users.id, project.ownerUserId)).limit(1).for("update");
        if (owner === undefined || owner.blockedAt !== null) throw projectAuthInvalid();
      }

      const [used] = await transaction.update(projectTokens).set({ lastUsedAt: now }).where(and(
        eq(projectTokens.projectId, project.id),
        eq(projectTokens.id, stored.id),
      )).returning({ id: projectTokens.id });
      if (used === undefined) throw projectAuthInvalid();

      return { projectId: project.id, connectionTokenId: stored.id };
    });
  }

  return { createProject, authenticateProject };
}

export type ProjectService = ReturnType<typeof createProjectService>;

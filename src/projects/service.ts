import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import {
  createProjectToken,
  parseProjectToken,
  verifyProjectToken,
} from "../auth/project-token.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { projectTokens, projects } from "../db/schema.js";
import { AgentMeshError } from "../errors.js";

interface ProjectServiceDependencies {
  db: AgentMeshDatabase;
}

export function createProjectService({ db }: ProjectServiceDependencies) {
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

  async function authenticateProject(token: string): Promise<string> {
    const parsed = parseProjectToken(token);
    if (parsed === null) {
      throw new AgentMeshError("PROJECT_AUTH_INVALID", "Project authentication failed");
    }

    const [stored] = await db
      .select({ projectId: projectTokens.projectId, tokenDigest: projectTokens.tokenDigest })
      .from(projectTokens)
      .where(eq(projectTokens.id, parsed.tokenId))
      .limit(1);
    if (stored === undefined || !verifyProjectToken(token, stored.tokenDigest)) {
      throw new AgentMeshError("PROJECT_AUTH_INVALID", "Project authentication failed");
    }

    return stored.projectId;
  }

  return { createProject, authenticateProject };
}

export type ProjectService = ReturnType<typeof createProjectService>;

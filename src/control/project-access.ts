import { and, eq, or, sql, type SQL } from "drizzle-orm";

import { projectMemberships, projects } from "../db/schema.js";

export function projectReadPredicate(userId: string, projectId?: string): SQL {
  const membership = sql<boolean>`exists (
    select 1
    from ${projectMemberships}
    where ${projectMemberships.projectId} = ${projects.id}
      and ${projectMemberships.userId} = ${userId}
  )`;
  return and(
    projectId === undefined ? undefined : eq(projects.id, projectId),
    or(eq(projects.ownerUserId, userId), membership),
  )!;
}

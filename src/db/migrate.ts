import { resolve } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { AgentMeshDatabase } from "./client.js";

export async function migrateDatabase(
  database: AgentMeshDatabase,
  migrationsFolder = resolve(process.cwd(), "drizzle"),
): Promise<void> {
  await migrate(database, { migrationsFolder });
}

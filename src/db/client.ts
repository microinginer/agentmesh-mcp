import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export const DATABASE_ACQUISITION_TIMEOUT_MS = 500;

export type AgentMeshDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  db: AgentMeshDatabase;
  pool: Pool;
}

export function createDatabase(connectionString: string): DatabaseConnection {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: DATABASE_ACQUISITION_TIMEOUT_MS,
  });
  return {
    pool,
    db: drizzle({ client: pool, schema }),
  };
}

import type { Pool } from "pg";

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      audit_events, web_sessions, oauth_identities,
      activity_events, messages, agents, project_tokens, projects, users
    RESTART IDENTITY CASCADE
  `);
}

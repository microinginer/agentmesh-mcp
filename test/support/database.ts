import type { Pool } from "pg";

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      audit_events, web_sessions, oauth_attempts, oauth_identities,
      blackboard_entries, agent_progress_reports, activity_events, messages, agents,
      project_tokens, project_invitations, project_memberships, projects, users
    RESTART IDENTITY CASCADE
  `);
}

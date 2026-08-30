import type { Pool } from "pg";

export const OBSERVER_ROLE_NAME = "agentmesh_observer";

const roleNamePattern = /^[a-z][a-z0-9_]{0,62}$/;

export async function ensureObserverRole(
  pool: Pool,
  password: string,
  roleName = OBSERVER_ROLE_NAME,
): Promise<void> {
  if (!roleNamePattern.test(roleName)) {
    throw new Error("Observer role name is invalid");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('agentmesh observer role provisioning', 0))",
    );
    await client.query(
      "SELECT set_config('agentmesh.observer_password', $1, true) IS NOT NULL",
      [password],
    );
    await client.query(`
      DO $observer_role$
      DECLARE
        granted_role record;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          EXECUTE format('CREATE ROLE %I LOGIN', '${roleName}');
        END IF;

        EXECUTE format(
          'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
          '${roleName}'
        );
        EXECUTE format(
          'ALTER ROLE %I PASSWORD %L',
          '${roleName}',
          current_setting('agentmesh.observer_password')
        );
        EXECUTE format(
          'ALTER ROLE %I SET default_transaction_read_only = on',
          '${roleName}'
        );

        FOR granted_role IN
          SELECT parent.rolname
            FROM pg_auth_members membership
            JOIN pg_roles member ON member.oid = membership.member
            JOIN pg_roles parent ON parent.oid = membership.roleid
           WHERE member.rolname = '${roleName}'
        LOOP
          EXECUTE format('REVOKE %I FROM %I', granted_role.rolname, '${roleName}');
        END LOOP;

        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC',
          current_database()
        );
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
          current_database(),
          '${roleName}'
        );
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO %I',
          current_database(),
          '${roleName}'
        );

        REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON SCHEMA drizzle FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA drizzle FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA drizzle FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON SCHEMA observer FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA observer FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA observer
          REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA observer
          REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC;

        EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', '${roleName}');
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
          '${roleName}'
        );
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
          '${roleName}'
        );
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I',
          '${roleName}'
        );
        EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA drizzle FROM %I', '${roleName}');
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA drizzle FROM %I',
          '${roleName}'
        );
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA drizzle FROM %I',
          '${roleName}'
        );
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA drizzle FROM %I',
          '${roleName}'
        );
        EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA observer FROM %I', '${roleName}');
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA observer FROM %I',
          '${roleName}'
        );
        EXECUTE format('GRANT USAGE ON SCHEMA observer TO %I', '${roleName}');
        EXECUTE format(
          'GRANT SELECT ON observer.projects, observer.agents, observer.messages, observer.activity_events TO %I',
          '${roleName}'
        );
      END
      $observer_role$
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

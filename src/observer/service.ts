import type { Pool } from "pg";

export const OBSERVER_ROLE_NAME = "agentmesh_observer";

const testRoleNamePattern = /^agentmesh_observer_test_[a-z0-9_]+$/;

export async function ensureObserverRole(
  pool: Pool,
  password: string,
  roleName = OBSERVER_ROLE_NAME,
): Promise<void> {
  if (
    roleName.length > 63 ||
    (roleName !== OBSERVER_ROLE_NAME && !testRoleNamePattern.test(roleName))
  ) {
    throw new Error("Observer role name is not allowed");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('agentmesh observer role provisioning', 0))",
    );
    const preflight = await client.query<{
      provisioner_allowed: boolean;
      target_owns_objects: boolean;
      conflicting_login_count: string;
    }>(
      `WITH database_info AS (
         SELECT database.oid, database.datdba
           FROM pg_database database
          WHERE database.datname = current_database()
       ),
       current_principal AS (
         SELECT role.oid, role.rolsuper
           FROM pg_roles role
          WHERE role.rolname = current_user
       ),
       target_principal AS (
         SELECT role.oid
           FROM pg_roles role
          WHERE role.rolname = $1
       )
       SELECT (
                current_principal.rolsuper
                OR current_principal.oid = database_info.datdba
              ) AS provisioner_allowed,
              EXISTS (
                SELECT 1
                  FROM pg_shdepend dependency
                  JOIN target_principal target
                    ON dependency.refclassid = 'pg_authid'::regclass
                   AND dependency.refobjid = target.oid
                 WHERE dependency.deptype = 'o'
              ) AS target_owns_objects,
              (
                SELECT count(*)::text
                  FROM pg_roles candidate
                 WHERE candidate.rolcanlogin
                   AND candidate.oid <> database_info.datdba
                   AND candidate.oid <> current_principal.oid
                   AND candidate.oid <> COALESCE(
                     (SELECT target.oid FROM target_principal target),
                     0
                   )
                   AND has_database_privilege(
                     candidate.oid,
                     database_info.oid,
                     'CONNECT'
                   )
              ) AS conflicting_login_count
         FROM database_info
         CROSS JOIN current_principal`,
      [roleName],
    );
    const preflightResult = preflight.rows[0];
    if (
      preflightResult === undefined ||
      !preflightResult.provisioner_allowed ||
      preflightResult.conflicting_login_count !== "0"
    ) {
      throw new Error(
        "Observer provisioning requires a dedicated AgentMesh database",
      );
    }
    if (preflightResult.target_owns_objects) {
      throw new Error("Observer role must not own database objects");
    }
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
        REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON SCHEMA drizzle FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA drizzle FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA drizzle FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON SCHEMA observer FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA observer FROM PUBLIC;
        REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA observer FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          REVOKE ALL PRIVILEGES ON ROUTINES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA observer
          REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA observer
          REVOKE ALL PRIVILEGES ON ROUTINES FROM PUBLIC;

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
          'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM %I',
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
          'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA drizzle FROM %I',
          '${roleName}'
        );
        EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA observer FROM %I', '${roleName}');
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA observer FROM %I',
          '${roleName}'
        );
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA observer FROM %I',
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

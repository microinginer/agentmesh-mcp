import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { createAuditService } from "../src/audit/service.js";
import { createDatabase } from "../src/db/client.js";
import { auditEvents, users } from "../src/db/schema.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { ensureObserverRole } from "../src/observer/service.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const parsedDatabaseUrl = new URL(databaseUrl);
const testRolePattern = /^agentmesh_observer_test_[a-z0-9_]+$/;
const testSuffix = randomBytes(8).toString("hex");
const roleName = `agentmesh_observer_test_${testSuffix}`;
const unrelatedRoleName = `agentmesh_unrelated_test_${testSuffix}`;
const ownedSchemaName = `observer_owned_test_${testSuffix}`;
const observerFunctionName = `observer_test_function_${testSuffix}`;
const observerProcedureName = `observer_test_procedure_${testSuffix}`;
const firstPassword = `first-'-%-\\-${randomBytes(24).toString("base64url")}`;
const observerPassword = `second-'-%-\\-${randomBytes(24).toString("base64url")}`;

function assertDedicatedIntegrationDatabase(): void {
  expect(parsedDatabaseUrl.protocol).toMatch(/^postgres(?:ql)?:$/);
  expect(parsedDatabaseUrl.hostname).toBe("127.0.0.1");
  expect(parsedDatabaseUrl.port).toBe("55432");
  expect(parsedDatabaseUrl.pathname).toBe("/agentmesh_test");
  expect(roleName).toMatch(testRolePattern);
}

function observerPool(password = observerPassword): Pool {
  return new Pool({
    host: parsedDatabaseUrl.hostname,
    port: Number(parsedDatabaseUrl.port),
    database: parsedDatabaseUrl.pathname.slice(1),
    user: roleName,
    password,
    max: 1,
  });
}

async function expectSqlState(
  client: PoolClient,
  statement: string,
  expectedState = "42501",
): Promise<void> {
  try {
    await client.query(statement);
    throw new Error(`Expected PostgreSQL SQLSTATE ${expectedState}`);
  } catch (error) {
    expect(error).toMatchObject({ code: expectedState });
  }
}

const database = createDatabase(databaseUrl);

beforeAll(async () => {
  assertDedicatedIntegrationDatabase();
  await migrateDatabase(database.db);
  await ensureObserverRole(database.pool, firstPassword, roleName);
  await database.pool.query(`GRANT USAGE ON SCHEMA drizzle TO ${roleName}`);
  await database.pool.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${roleName}`,
  );
  await database.pool.query(`
    CREATE FUNCTION observer.${observerFunctionName}()
    RETURNS text
    LANGUAGE sql
    AS $$ SELECT 'unsafe'::text $$
  `);
  await database.pool.query(`
    CREATE PROCEDURE observer.${observerProcedureName}()
    LANGUAGE plpgsql
    AS $$ BEGIN NULL; END $$
  `);
  await database.pool.query(
    `GRANT EXECUTE ON FUNCTION observer.${observerFunctionName}() TO PUBLIC, ${roleName}`,
  );
  await database.pool.query(
    `GRANT EXECUTE ON PROCEDURE observer.${observerProcedureName}() TO PUBLIC, ${roleName}`,
  );
  await ensureObserverRole(database.pool, observerPassword, roleName);
});

afterAll(async () => {
  assertDedicatedIntegrationDatabase();
  const existing = await database.pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [roleName],
  );
  if (existing.rows[0]?.exists === true) {
    const active = await database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
      [roleName],
    );
    expect(active.rows[0]?.count).toBe("0");
    await database.pool.query(
      `DROP FUNCTION IF EXISTS observer.${observerFunctionName}()`,
    );
    await database.pool.query(
      `DROP PROCEDURE IF EXISTS observer.${observerProcedureName}()`,
    );
    await database.pool.query(`DROP OWNED BY ${roleName}`);
    await database.pool.query(`DROP ROLE ${roleName}`);
  }
  await database.pool.end();
});

describe("pgAdmin observer database boundary", () => {
  it("rejects every role override except the production role or a unique test role before connecting", async () => {
    for (const invalidRoleName of [
      "agentmesh",
      "postgres",
      "generic_valid_role",
      "agentmesh_observer_test_",
      `agentmesh_observer_test_${"a".repeat(64)}`,
    ]) {
      let connectCalls = 0;
      const fakePool = {
        connect: async () => {
          connectCalls += 1;
          throw new Error("pool connect must not run");
        },
      } as unknown as Pool;

      await expect(
        ensureObserverRole(fakePool, observerPassword, invalidRoleName),
      ).rejects.toThrow("Observer role name is not allowed");
      expect(connectCalls).toBe(0);
    }
  });

  it("exposes exactly seven safe views without digests or session rows", async () => {
    const views = await database.pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.views
        WHERE table_schema = 'observer'
        ORDER BY table_name`,
    );
    expect(views.rows.map((row) => row.table_name)).toEqual([
      "activity_events",
      "agents",
      "audit_events",
      "connections",
      "messages",
      "projects",
      "users",
    ]);

    const columns = await database.pool.query<{
      table_name: string;
      column_name: string;
      ordinal_position: number;
    }>(
      `SELECT table_name, column_name, ordinal_position
         FROM information_schema.columns
        WHERE table_schema = 'observer'
        ORDER BY table_name, ordinal_position`,
    );
    const byView = Object.groupBy(columns.rows, (row) => row.table_name);
    expect(byView.projects?.map((row) => row.column_name)).toEqual([
      "id",
      "name",
      "created_at",
    ]);
    expect(byView.agents?.map((row) => row.column_name)).toEqual([
      "id",
      "project_id",
      "name",
      "client",
      "capabilities",
      "last_seen_at",
      "created_at",
    ]);
    expect(byView.messages?.map((row) => row.column_name)).toEqual([
      "sequence",
      "id",
      "project_id",
      "sender_agent_id",
      "recipient_agent_id",
      "text",
      "created_at",
      "acknowledged_at",
    ]);
    expect(byView.activity_events?.map((row) => row.column_name)).toEqual([
      "sequence",
      "id",
      "project_id",
      "request_id",
      "event_type",
      "outcome",
      "actor_agent_id",
      "target_agent_id",
      "message_id",
      "error_code",
      "metadata",
      "created_at",
    ]);
    expect(byView.audit_events?.map((row) => row.column_name)).toEqual([
      "id",
      "user_id",
      "project_id",
      "event_type",
      "metadata",
      "created_at",
    ]);
    expect(byView.connections?.map((row) => row.column_name)).toEqual([
      "id",
      "project_id",
      "label",
      "created_by_user_id",
      "expires_at",
      "last_used_at",
      "revoked_at",
      "created_at",
    ]);
    expect(byView.users?.map((row) => row.column_name)).toEqual([
      "id",
      "display_name",
      "avatar_url",
      "blocked_at",
      "created_at",
      "updated_at",
    ]);
    expect(byView.project_tokens).toBeUndefined();
    expect(columns.rows.map((row) => row.column_name)).not.toContain("registration_digest");
    expect(columns.rows.map((row) => row.column_name)).not.toContain("idempotency_key");
    expect(columns.rows.map((row) => row.column_name)).not.toContain("token_digest");
    expect(columns.rows.map((row) => row.column_name)).not.toContain("csrf_digest");
  });

  it("keeps PUBLIC out of the observer schema and views", async () => {
    const privileges = await database.pool.query<{ object_name: string }>(
      `SELECT n.nspname AS object_name
         FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
        WHERE n.nspname = 'observer' AND acl.grantee = 0
       UNION ALL
       SELECT c.relname AS object_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
        WHERE n.nspname = 'observer' AND c.relkind = 'v' AND acl.grantee = 0`,
    );
    expect(privileges.rows).toEqual([]);
  });

  it("provisions an idempotent login role with only safe role attributes", async () => {
    const role = await database.pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls
         FROM pg_roles
        WHERE rolname = $1`,
      [roleName],
    );
    expect(role.rows).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);

    const memberships = await database.pool.query(
      `SELECT 1
         FROM pg_auth_members membership
         JOIN pg_roles member ON member.oid = membership.member
        WHERE member.rolname = $1`,
      [roleName],
    );
    expect(memberships.rows).toEqual([]);

    const privileges = await database.pool.query<{
      can_connect: boolean;
      can_create_database_objects: boolean;
      can_create_temporary_tables: boolean;
      can_use_observer: boolean;
      can_create_in_observer: boolean;
      can_use_public: boolean;
      can_use_drizzle: boolean;
    }>(
      `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS can_connect,
              has_database_privilege($1, current_database(), 'CREATE') AS can_create_database_objects,
              has_database_privilege($1, current_database(), 'TEMPORARY') AS can_create_temporary_tables,
              has_schema_privilege($1, 'observer', 'USAGE') AS can_use_observer,
              has_schema_privilege($1, 'observer', 'CREATE') AS can_create_in_observer,
              has_schema_privilege($1, 'public', 'USAGE') AS can_use_public,
              has_schema_privilege($1, 'drizzle', 'USAGE') AS can_use_drizzle`,
      [roleName],
    );
    expect(privileges.rows).toEqual([
      {
        can_connect: true,
        can_create_database_objects: false,
        can_create_temporary_tables: false,
        can_use_observer: true,
        can_create_in_observer: false,
        can_use_public: false,
        can_use_drizzle: false,
      },
    ]);

    const ownedObjects = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM (
           SELECT c.oid
             FROM pg_class c
             JOIN pg_roles owner ON owner.oid = c.relowner
            WHERE owner.rolname = $1
           UNION ALL
           SELECT n.oid
             FROM pg_namespace n
             JOIN pg_roles owner ON owner.oid = n.nspowner
            WHERE owner.rolname = $1
           UNION ALL
           SELECT d.oid
             FROM pg_database d
             JOIN pg_roles owner ON owner.oid = d.datdba
            WHERE owner.rolname = $1
         ) owned`,
      [roleName],
    );
    expect(ownedObjects.rows).toEqual([{ count: "0" }]);

    const connection = observerPool();
    await expect(connection.query("SELECT current_user")).resolves.toMatchObject({
      rows: [{ current_user: roleName }],
    });
    await connection.end();

    const stalePasswordConnection = observerPool(firstPassword);
    await expect(stalePasswordConnection.query("SELECT current_user")).rejects.toMatchObject({
      code: "28P01",
    });
    await stalePasswordConnection.end();
  });

  it("defaults every new observer connection to read-only transactions", async () => {
    const connection = observerPool();
    const setting = await connection.query<{ default_transaction_read_only: string }>(
      "SHOW default_transaction_read_only",
    );
    expect(setting.rows).toEqual([{ default_transaction_read_only: "on" }]);
    await connection.end();
  });

  it("allows SELECT on every observer view and nowhere in the base tables", async () => {
    const connection = observerPool();
    const client = await connection.connect();
    try {
      for (const view of [
        "projects", "agents", "messages", "activity_events", "users", "connections", "audit_events",
      ]) {
        await expect(client.query(`SELECT * FROM observer.${view} LIMIT 1`)).resolves.toBeDefined();
      }
      for (const table of [
        "projects",
        "project_tokens",
        "agents",
        "messages",
        "activity_events",
        "users",
        "oauth_identities",
        "web_sessions",
        "oauth_attempts",
        "audit_events",
      ]) {
        await expectSqlState(client, `SELECT * FROM public.${table} LIMIT 1`);
      }
    } finally {
      client.release();
      await connection.end();
    }
  });

  it("serializes only service-derived audit attribution through the observer view", async () => {
    const projectId = randomUUID();
    const requestId = randomUUID();
    const plantedSecret = "observer-audit-secret-must-not-leak";
    const [actor, subject] = await database.db.insert(users).values([
      { displayName: "Observer audit actor" },
      { displayName: "Observer audit subject" },
    ]).returning();
    if (actor === undefined || subject === undefined) throw new Error("audit users insert failed");
    const service = createAuditService({ db: database.db });
    const connection = observerPool();
    try {
      await service.record({
        subjectUserId: subject.id,
        projectId,
        actor: { kind: "user", userId: actor.id },
        requestId,
        eventType: "operator.project_archived",
        metadata: {
          actor_user_id: plantedSecret,
          subject_user_id: plantedSecret,
          request_id: plantedSecret,
          token: plantedSecret,
        } as unknown as import("../src/audit/types.js").AuditMetadata,
      });
      const observed = await connection.query<{
        user_id: string | null;
        metadata: Record<string, unknown>;
      }>(
        "SELECT user_id, metadata FROM observer.audit_events WHERE project_id = $1",
        [projectId],
      );
      expect(observed.rows).toEqual([{
        user_id: subject.id,
        metadata: {
          actor_kind: "user",
          actor_user_id: actor.id,
          subject_user_id: subject.id,
          request_id: requestId,
        },
      }]);
      expect(JSON.stringify(observed.rows)).not.toContain(plantedSecret);
    } finally {
      await connection.end();
      await database.db.delete(auditEvents);
      await database.db.delete(users);
    }
  });

  it("revokes stale function and procedure execution in the observer schema", async () => {
    const connection = observerPool();
    const client = await connection.connect();
    try {
      await expectSqlState(
        client,
        `SELECT observer.${observerFunctionName}()`,
      );
      await expectSqlState(
        client,
        `CALL observer.${observerProcedureName}()`,
      );
    } finally {
      client.release();
      await connection.end();
    }
  });

  it("rejects an existing observer that owns an object before changing the role", async () => {
    const attemptedPassword = `owned-'-%-\\-${randomBytes(24).toString("base64url")}`;
    let rejected: unknown;
    let beforeRows: Record<string, unknown>[] = [];
    let afterRows: Record<string, unknown>[] = [];
    try {
      await database.pool.query(
        `CREATE SCHEMA ${ownedSchemaName} AUTHORIZATION ${roleName}`,
      );
      const before = await database.pool.query(
        `SELECT role.rolpassword, role.rolcanlogin, role.rolsuper, role.rolcreatedb,
                role.rolcreaterole, role.rolinherit, role.rolreplication,
                role.rolbypassrls,
                COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object('database', setting.setdatabase, 'config', setting.setconfig)
                    ORDER BY setting.setdatabase
                  )
                    FROM pg_db_role_setting setting
                   WHERE setting.setrole = role.oid
                ), '[]'::jsonb) AS role_settings
           FROM pg_authid role
          WHERE role.rolname = $1`,
        [roleName],
      );
      beforeRows = before.rows;
      try {
        await ensureObserverRole(database.pool, attemptedPassword, roleName);
      } catch (error) {
        rejected = error;
      }
      const after = await database.pool.query(
        `SELECT role.rolpassword, role.rolcanlogin, role.rolsuper, role.rolcreatedb,
                role.rolcreaterole, role.rolinherit, role.rolreplication,
                role.rolbypassrls,
                COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object('database', setting.setdatabase, 'config', setting.setconfig)
                    ORDER BY setting.setdatabase
                  )
                    FROM pg_db_role_setting setting
                   WHERE setting.setrole = role.oid
                ), '[]'::jsonb) AS role_settings
           FROM pg_authid role
          WHERE role.rolname = $1`,
        [roleName],
      );
      afterRows = after.rows;
    } finally {
      const active = await database.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
        [roleName],
      );
      expect(active.rows).toEqual([{ count: "0" }]);
      await database.pool.query(`ALTER SCHEMA ${ownedSchemaName} OWNER TO CURRENT_USER`);
      await database.pool.query(`DROP SCHEMA ${ownedSchemaName}`);
    }

    expect(rejected).toMatchObject({
      message: "Observer role must not own database objects",
    });
    expect(String(rejected)).not.toContain(roleName);
    expect(String(rejected)).not.toContain(attemptedPassword);
    expect(afterRows).toEqual(beforeRows);
  });

  it("rejects a database usable by an unrelated login without mutating role or PUBLIC ACLs", async () => {
    const attemptedPassword = `preflight-'-%-\\-${randomBytes(24).toString("base64url")}`;
    const originalPublicConnect = await database.pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_database database
           CROSS JOIN LATERAL aclexplode(
             COALESCE(database.datacl, acldefault('d', database.datdba))
           ) privilege
          WHERE database.datname = current_database()
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'CONNECT'
       ) AS allowed`,
    );

    let rejected: unknown;
    let beforeRoleRows: Record<string, unknown>[] = [];
    let afterRoleRows: Record<string, unknown>[] = [];
    let beforeAclRows: Array<{ datacl: string | null }> = [];
    let afterAclRows: Array<{ datacl: string | null }> = [];
    try {
      await database.pool.query(`CREATE ROLE ${unrelatedRoleName} LOGIN`);
      await database.pool.query(
        `GRANT CONNECT ON DATABASE agentmesh_test TO PUBLIC`,
      );
      const beforeRole = await database.pool.query(
        `SELECT role.rolpassword, role.rolcanlogin, role.rolsuper, role.rolcreatedb,
                role.rolcreaterole, role.rolinherit, role.rolreplication,
                role.rolbypassrls,
                COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object('database', setting.setdatabase, 'config', setting.setconfig)
                    ORDER BY setting.setdatabase
                  )
                    FROM pg_db_role_setting setting
                   WHERE setting.setrole = role.oid
                ), '[]'::jsonb) AS role_settings
           FROM pg_authid role
          WHERE role.rolname = $1`,
        [roleName],
      );
      beforeRoleRows = beforeRole.rows;
      const beforeAcl = await database.pool.query<{ datacl: string | null }>(
        "SELECT datacl::text AS datacl FROM pg_database WHERE datname = current_database()",
      );
      beforeAclRows = beforeAcl.rows;
      const unrelatedAccess = await database.pool.query<{
        can_connect: boolean;
        has_direct_connect: boolean;
      }>(
        `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS can_connect,
                EXISTS (
                  SELECT 1
                    FROM pg_database database
                    CROSS JOIN LATERAL aclexplode(
                      COALESCE(database.datacl, acldefault('d', database.datdba))
                    ) privilege
                   WHERE database.datname = current_database()
                     AND privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
                     AND privilege.privilege_type = 'CONNECT'
                ) AS has_direct_connect`,
        [unrelatedRoleName],
      );
      expect(unrelatedAccess.rows).toEqual([
        { can_connect: true, has_direct_connect: false },
      ]);

      try {
        await ensureObserverRole(database.pool, attemptedPassword, roleName);
      } catch (error) {
        rejected = error;
      }
      const afterRole = await database.pool.query(
        `SELECT role.rolpassword, role.rolcanlogin, role.rolsuper, role.rolcreatedb,
                role.rolcreaterole, role.rolinherit, role.rolreplication,
                role.rolbypassrls,
                COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object('database', setting.setdatabase, 'config', setting.setconfig)
                    ORDER BY setting.setdatabase
                  )
                    FROM pg_db_role_setting setting
                   WHERE setting.setrole = role.oid
                ), '[]'::jsonb) AS role_settings
           FROM pg_authid role
          WHERE role.rolname = $1`,
        [roleName],
      );
      afterRoleRows = afterRole.rows;
      const afterAcl = await database.pool.query<{ datacl: string | null }>(
        "SELECT datacl::text AS datacl FROM pg_database WHERE datname = current_database()",
      );
      afterAclRows = afterAcl.rows;
    } finally {
      const active = await database.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
        [unrelatedRoleName],
      );
      expect(active.rows).toEqual([{ count: "0" }]);
      await database.pool.query(`DROP OWNED BY ${unrelatedRoleName}`);
      await database.pool.query(`DROP ROLE ${unrelatedRoleName}`);
      if (originalPublicConnect.rows[0]?.allowed === true) {
        await database.pool.query(
          "GRANT CONNECT ON DATABASE agentmesh_test TO PUBLIC",
        );
      } else {
        await database.pool.query(
          "REVOKE CONNECT ON DATABASE agentmesh_test FROM PUBLIC",
        );
      }
      await ensureObserverRole(database.pool, observerPassword, roleName);
    }

    expect(rejected).toMatchObject({
      message: "Observer provisioning requires a dedicated AgentMesh database",
    });
    expect(String(rejected)).not.toContain(roleName);
    expect(String(rejected)).not.toContain(unrelatedRoleName);
    expect(String(rejected)).not.toContain(attemptedPassword);
    expect(afterRoleRows).toEqual(beforeRoleRows);
    expect(afterAclRows).toEqual(beforeAclRows);
  });

  it("cannot mutate, create, truncate, execute application functions, or assume a role", async () => {
    const connection = observerPool();
    const client = await connection.connect();
    try {
      await client.query("SET default_transaction_read_only = off");
      for (const statement of [
        "INSERT INTO observer.projects (name) VALUES ('forbidden')",
        "INSERT INTO public.projects (name) VALUES ('forbidden')",
        "CREATE TABLE public.observer_forbidden (id integer)",
        "CREATE TEMP TABLE observer_forbidden_temp (id integer)",
        "TRUNCATE TABLE public.projects",
        "SET ROLE agentmesh",
      ]) {
        await expectSqlState(client, statement);
      }
    } finally {
      client.release();
      await connection.end();
    }

    const unsafePrivileges = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.role_table_grants
        WHERE grantee = $1
          AND NOT (
            table_schema = 'observer'
            AND table_name IN ('projects', 'agents', 'messages', 'activity_events', 'users', 'connections', 'audit_events')
            AND privilege_type = 'SELECT'
          )`,
      [roleName],
    );
    expect(unsafePrivileges.rows).toEqual([{ count: "0" }]);

    const executableApplicationRoutines = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.role_routine_grants
        WHERE grantee IN ($1, 'PUBLIC')
          AND specific_schema IN ('public', 'drizzle', 'observer')`,
      [roleName],
    );
    expect(executableApplicationRoutines.rows).toEqual([{ count: "0" }]);
  });
});

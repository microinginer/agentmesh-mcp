import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { ensureObserverRole } from "../src/observer/service.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const parsedDatabaseUrl = new URL(databaseUrl);
const testRolePattern = /^agentmesh_observer_test_[a-z0-9_]+$/;
const roleName = `agentmesh_observer_test_${randomBytes(8).toString("hex")}`;
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
    await database.pool.query(`DROP OWNED BY ${roleName}`);
    await database.pool.query(`DROP ROLE ${roleName}`);
  }
  await database.pool.end();
});

describe("pgAdmin observer database boundary", () => {
  it("exposes exactly four views with only the approved columns", async () => {
    const views = await database.pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.views
        WHERE table_schema = 'observer'
        ORDER BY table_name`,
    );
    expect(views.rows.map((row) => row.table_name)).toEqual([
      "activity_events",
      "agents",
      "messages",
      "projects",
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
    expect(byView.project_tokens).toBeUndefined();
    expect(columns.rows.map((row) => row.column_name)).not.toContain("registration_digest");
    expect(columns.rows.map((row) => row.column_name)).not.toContain("idempotency_key");
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
      for (const view of ["projects", "agents", "messages", "activity_events"]) {
        await expect(client.query(`SELECT * FROM observer.${view} LIMIT 1`)).resolves.toBeDefined();
      }
      for (const table of [
        "projects",
        "project_tokens",
        "agents",
        "messages",
        "activity_events",
      ]) {
        await expectSqlState(client, `SELECT * FROM public.${table} LIMIT 1`);
      }
    } finally {
      client.release();
      await connection.end();
    }
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
            AND table_name IN ('projects', 'agents', 'messages', 'activity_events')
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

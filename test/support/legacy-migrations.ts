import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Pool } from "pg";

import { createDatabase, type DatabaseConnection } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";

interface LegacyMigrationFixture {
  database: DatabaseConnection;
  migrateHosted(): Promise<void>;
  destroy(): Promise<void>;
}

interface MigrationJournal {
  version: string;
  dialect: string;
  entries: Array<{ idx: number }>;
}

function migrationDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createLegacyMigrationsFolder(): Promise<{ root: string; folder: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentmesh-legacy-migrations-"));
  const folder = join(root, "drizzle");
  const metaFolder = join(folder, "meta");
  const sourceFolder = resolve(process.cwd(), "drizzle");

  await cp(sourceFolder, folder, { recursive: true });
  await Promise.all([
    rm(join(folder, "0003_hosted_control_plane.sql"), { force: true }),
    rm(join(metaFolder, "0003_snapshot.json"), { force: true }),
  ]);
  const journalPath = join(metaFolder, "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal;
  journal.entries = journal.entries.filter((entry) => entry.idx <= 2);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  return { root, folder };
}

export async function createLegacyMigrationFixture(
  testDatabaseUrl: string,
): Promise<LegacyMigrationFixture> {
  const databaseName = `agentmesh_legacy_${randomUUID().replaceAll("-", "")}`;
  const migrationDatabase = migrationDatabaseUrl(testDatabaseUrl, databaseName);
  const provisioner = new Pool({ connectionString: testDatabaseUrl });
  const migrations = await createLegacyMigrationsFolder();
  let database: DatabaseConnection | undefined;

  try {
    await provisioner.query(`CREATE DATABASE "${databaseName}"`);
    database = createDatabase(migrationDatabase);
    await migrateDatabase(database.db, migrations.folder);
  } catch (error) {
    await database?.pool.end();
    await provisioner.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await rm(migrations.root, { recursive: true, force: true });
    await provisioner.end();
    throw error;
  }

  return {
    database,
    migrateHosted: () => migrateDatabase(database.db),
    async destroy(): Promise<void> {
      await database.pool.end();
      await provisioner.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await provisioner.end();
      await rm(migrations.root, { recursive: true, force: true });
    },
  };
}

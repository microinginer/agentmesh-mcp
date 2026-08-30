import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import {
  ensureObserverRole,
  OBSERVER_ROLE_NAME,
} from "./observer/service.js";
import { createProjectService, type ProjectService } from "./projects/service.js";

interface CliDependencies {
  projectService: Pick<ProjectService, "createProject">;
  observerPassword?: string | undefined;
  ensureObserverRole?: ((password: string) => Promise<void>) | undefined;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const projectNameSchema = z.string().trim().min(1).max(100);
const observerPasswordSchema = z.string().min(24);
const usage = [
  "Usage: agentmesh project create --name <name>",
  "Usage: agentmesh db observer ensure",
];

function printUsage(stderr: (line: string) => void): void {
  for (const line of usage) {
    stderr(line);
  }
}

export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  const isProjectCreate =
    args.length === 4 &&
    args[0] === "project" &&
    args[1] === "create" &&
    args[2] === "--name";
  if (isProjectCreate) {
    const parsedName = projectNameSchema.safeParse(args[3]);
    if (!parsedName.success) {
      dependencies.stderr("Project name must contain 1 to 100 characters");
      return 1;
    }

    const created = await dependencies.projectService.createProject(parsedName.data);
    dependencies.stdout(
      JSON.stringify({
        project_id: created.project.id,
        name: created.project.name,
        token_id: created.token_id,
        token: created.token,
      }),
    );
    return 0;
  }

  const isObserverEnsure =
    args.length === 3 && args[0] === "db" && args[1] === "observer" && args[2] === "ensure";
  if (isObserverEnsure) {
    const parsedPassword = observerPasswordSchema.safeParse(dependencies.observerPassword);
    if (!parsedPassword.success) {
      dependencies.stderr(
        "AGENTMESH_DB_OBSERVER_PASSWORD must contain at least 24 characters",
      );
      return 1;
    }
    if (dependencies.ensureObserverRole === undefined) {
      throw new Error("Observer role provisioning is unavailable");
    }

    await dependencies.ensureObserverRole(parsedPassword.data);
    dependencies.stdout(JSON.stringify({ ok: true, role: OBSERVER_ROLE_NAME }));
    return 0;
  }

  printUsage(dependencies.stderr);
  return 1;
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    process.stderr.write("DATABASE_URL is required\n");
    return 1;
  }

  const database = createDatabase(databaseUrl);
  try {
    await migrateDatabase(database.db);
    return await runCli(process.argv.slice(2), {
      projectService: createProjectService({ db: database.db }),
      observerPassword: process.env.AGENTMESH_DB_OBSERVER_PASSWORD,
      ensureObserverRole: (password) => ensureObserverRole(database.pool, password),
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    await database.pool.end();
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  process.exitCode = await main();
}

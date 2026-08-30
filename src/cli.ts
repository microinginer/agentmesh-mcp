import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { createProjectService, type ProjectService } from "./projects/service.js";

interface CliDependencies {
  projectService: Pick<ProjectService, "createProject">;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const projectNameSchema = z.string().trim().min(1).max(100);

export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  if (
    args.length !== 4 ||
    args[0] !== "project" ||
    args[1] !== "create" ||
    args[2] !== "--name"
  ) {
    dependencies.stderr("Usage: agentmesh project create --name <name>");
    return 1;
  }

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

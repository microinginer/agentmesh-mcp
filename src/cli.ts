import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { createAuditService } from "./audit/service.js";
import {
  createOperatorService,
  OperatorControlError,
  type OperatorService,
} from "./control/operator-service.js";
import { uuidV4Schema } from "./contracts.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import {
  ensureObserverRole,
  OBSERVER_ROLE_NAME,
} from "./observer/service.js";
import { createProjectService, type ProjectService } from "./projects/service.js";

interface CliDependencies {
  projectService: Pick<ProjectService, "createProject">;
  operatorService?: Pick<OperatorService, "assignOwner"> | undefined;
  observerPassword?: string | undefined;
  ensureObserverRole?: ((password: string) => Promise<void>) | undefined;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const projectNameSchema = z.string().trim().min(1).max(100);
const observerPasswordSchema = z.string().min(24);
const githubUserIdSchema = z.string().regex(/^[1-9]\d{0,63}$/);
const usage = [
  "Usage: agentmesh project create --name <name>",
  "Usage: agentmesh project assign-owner --project-id <uuid> --github-user-id <numeric-id>",
  "Usage: agentmesh db observer ensure",
];

function printUsage(stderr: (line: string) => void): void {
  for (const line of usage) {
    stderr(line);
  }
}

export function parseCliProjectLimit(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d{1,3}$/.test(value)) throw new Error("Invalid AGENTMESH_PROJECT_LIMIT");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("Invalid AGENTMESH_PROJECT_LIMIT");
  }
  return parsed;
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

  const isProjectAssignOwner =
    args.length === 6
    && args[0] === "project"
    && args[1] === "assign-owner"
    && args[2] === "--project-id"
    && args[4] === "--github-user-id";
  if (isProjectAssignOwner) {
    const projectId = uuidV4Schema.safeParse(args[3]);
    const githubUserId = githubUserIdSchema.safeParse(args[5]);
    if (!projectId.success || !githubUserId.success) {
      dependencies.stderr("Invalid project assignment arguments");
      return 1;
    }
    if (dependencies.operatorService === undefined) {
      throw new Error("Project owner assignment is unavailable");
    }
    try {
      const assigned = await dependencies.operatorService.assignOwner({
        projectId: projectId.data,
        githubUserId: githubUserId.data,
        requestId: randomUUID(),
      });
      dependencies.stdout(JSON.stringify({
        ok: true,
        project_id: assigned.projectId,
        owner_user_id: assigned.ownerUserId,
        github_user_id: assigned.githubUserId,
      }));
      return 0;
    } catch (error) {
      if (!(error instanceof OperatorControlError)) throw error;
      const message = {
        INVALID_REQUEST: "invalid arguments",
        USER_NOT_FOUND: "user not found",
        USER_BLOCKED: "user is blocked",
        USER_STATE_CONFLICT: "user state conflict",
        PROJECT_NOT_FOUND: "project not found or already owned",
        PROJECT_STATE_CONFLICT: "project state conflict",
        PROJECT_LIMIT_REACHED: "active project limit reached",
        CONTROL_UNAVAILABLE: "temporarily unavailable",
      }[error.code];
      dependencies.stderr(`Project owner assignment failed: ${message}`);
      return 1;
    }
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
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) {
    process.stderr.write("DATABASE_URL is required\n");
    return 1;
  }

  const database = createDatabase(process.env.DATABASE_URL);
  try {
    await migrateDatabase(database.db);
    return await runCli(process.argv.slice(2), {
      projectService: createProjectService({ db: database.db }),
      operatorService: createOperatorService({
        db: database.db,
        audit: createAuditService({ db: database.db }),
        projectLimit: parseCliProjectLimit(process.env.AGENTMESH_PROJECT_LIMIT),
      }),
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

import { and, desc, eq, isNull } from "drizzle-orm";

import type { AuditService } from "../audit/service.js";
import { createProjectToken } from "../auth/project-token.js";
import { uuidV4Schema } from "../contracts.js";
import type { AgentMeshDatabase } from "../db/client.js";
import { projectTokens, projects, users } from "../db/schema.js";
import { projectReadPredicate } from "./project-access.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_TOKEN_TTL_DAYS = 3_650;

export type ConnectionControlErrorCode =
  | "INVALID_REQUEST"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_STATE_CONFLICT"
  | "CONNECTION_NOT_FOUND"
  | "CONNECTION_STATE_CONFLICT"
  | "CONTROL_UNAVAILABLE";

export class ConnectionControlError extends Error {
  readonly code: ConnectionControlErrorCode;

  constructor(code: ConnectionControlErrorCode) {
    super(code);
    this.name = "ConnectionControlError";
    this.code = code;
  }
}

export type ConnectionStatus = "active" | "expired" | "revoked";

export interface PublicControlConnection {
  id: string;
  label: string;
  status: ConnectionStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface IssuedControlConnection {
  connectionId: string;
  label: string;
  status: ConnectionStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  secret: string | null;
  secretRecoverable: boolean;
}

interface ConnectionServiceDependencies {
  db: AgentMeshDatabase;
  audit: AuditService;
  tokenTtlDays: number;
  clock?: () => Date;
}

interface IssueConnectionInput {
  ownerUserId: string;
  projectId: string;
  label: string;
  idempotencyKey: string;
  requestId: string;
}

interface ListConnectionsInput {
  userId: string;
  projectId: string;
  limit: number;
}

interface RevokeConnectionInput {
  ownerUserId: string;
  projectId: string;
  connectionId: string;
  requestId: string;
}

type ConnectionRow = {
  id: string;
  label: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const safeConnectionSelection = {
  id: projectTokens.id,
  label: projectTokens.label,
  expiresAt: projectTokens.expiresAt,
  lastUsedAt: projectTokens.lastUsedAt,
  revokedAt: projectTokens.revokedAt,
  createdAt: projectTokens.createdAt,
};

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function validUuid(value: string): boolean {
  return uuidV4Schema.safeParse(value).success;
}

function normalizedLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  const label = value.trim();
  return label.length >= 1 && label.length <= 80 ? label : null;
}

function publicConnection(row: ConnectionRow, now: Date): PublicControlConnection {
  const status: ConnectionStatus = row.revokedAt !== null
    ? "revoked"
    : row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()
      ? "expired"
      : "active";
  return {
    id: row.id,
    label: row.label,
    status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function issuedConnection(
  row: ConnectionRow,
  now: Date,
  secret: string | null,
): IssuedControlConnection {
  const connection = publicConnection(row, now);
  return {
    connectionId: connection.id,
    label: connection.label,
    status: connection.status,
    expiresAt: connection.expiresAt,
    lastUsedAt: connection.lastUsedAt,
    revokedAt: connection.revokedAt,
    createdAt: connection.createdAt,
    secret,
    secretRecoverable: secret !== null,
  };
}

export function createConnectionService(dependencies: ConnectionServiceDependencies) {
  const { db, audit, tokenTtlDays } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  function nowAndExpiry(): { now: Date; expiresAt: Date } {
    const now = clock();
    const ttlIsValid = Number.isInteger(tokenTtlDays)
      && tokenTtlDays >= 1
      && tokenTtlDays <= MAX_TOKEN_TTL_DAYS;
    const expiresAt = new Date(now.getTime() + tokenTtlDays * DAY_MS);
    if (!ttlIsValid || !validDate(now) || !validDate(expiresAt) || expiresAt <= now) {
      throw new ConnectionControlError("CONTROL_UNAVAILABLE");
    }
    return { now, expiresAt };
  }

  async function lockOwnedProject(
    transaction: Parameters<Parameters<AgentMeshDatabase["transaction"]>[0]>[0],
    ownerUserId: string,
    projectId: string,
  ) {
    const [project] = await transaction.select({
      id: projects.id,
      status: projects.status,
    }).from(projects).where(and(
      eq(projects.id, projectId),
      eq(projects.ownerUserId, ownerUserId),
    )).limit(1).for("update");
    if (project === undefined) throw new ConnectionControlError("PROJECT_NOT_FOUND");

    const [owner] = await transaction.select({ blockedAt: users.blockedAt }).from(users)
      .where(eq(users.id, ownerUserId)).limit(1);
    if (owner === undefined || owner.blockedAt !== null) {
      throw new ConnectionControlError("PROJECT_NOT_FOUND");
    }
    return project;
  }

  async function issue(input: IssueConnectionInput): Promise<IssuedControlConnection> {
    const label = normalizedLabel(input.label);
    if (
      label === null
      || !validUuid(input.ownerUserId)
      || !validUuid(input.projectId)
      || !validUuid(input.idempotencyKey)
    ) {
      throw new ConnectionControlError("INVALID_REQUEST");
    }
    return db.transaction(async (transaction) => {
      const project = await lockOwnedProject(
        transaction,
        input.ownerUserId,
        input.projectId,
      );
      if (project.status !== "active") {
        throw new ConnectionControlError("PROJECT_STATE_CONFLICT");
      }
      const { now, expiresAt } = nowAndExpiry();

      const [existing] = await transaction.select(safeConnectionSelection).from(projectTokens)
        .where(and(
          eq(projectTokens.projectId, input.projectId),
          eq(projectTokens.createIdempotencyKey, input.idempotencyKey),
        )).limit(1);
      if (existing !== undefined) return issuedConnection(existing, now, null);

      const token = createProjectToken();
      const [inserted] = await transaction.insert(projectTokens).values({
        id: token.tokenId,
        projectId: input.projectId,
        tokenDigest: token.digest,
        label,
        createdByUserId: input.ownerUserId,
        expiresAt,
        createIdempotencyKey: input.idempotencyKey,
        createdAt: now,
      }).onConflictDoNothing({
        target: [projectTokens.projectId, projectTokens.createIdempotencyKey],
      }).returning(safeConnectionSelection);

      if (inserted === undefined) {
        const [replayed] = await transaction.select(safeConnectionSelection).from(projectTokens)
          .where(and(
            eq(projectTokens.projectId, input.projectId),
            eq(projectTokens.createIdempotencyKey, input.idempotencyKey),
          )).limit(1);
        if (replayed === undefined) throw new ConnectionControlError("CONTROL_UNAVAILABLE");
        return issuedConnection(replayed, now, null);
      }

      await audit.record({
        userId: input.ownerUserId,
        projectId: input.projectId,
        eventType: "connection.created",
        metadata: { connection_label: inserted.label },
      }, transaction);
      return issuedConnection(inserted, now, token.token);
    });
  }

  async function list(input: ListConnectionsInput): Promise<PublicControlConnection[]> {
    if (
      !validUuid(input.userId)
      || !validUuid(input.projectId)
      || !Number.isInteger(input.limit)
      || input.limit < 1
      || input.limit > 100
    ) {
      throw new ConnectionControlError("INVALID_REQUEST");
    }
    const now = clock();
    if (!validDate(now)) throw new ConnectionControlError("CONTROL_UNAVAILABLE");

    const rows = await db.select({
      projectId: projects.id,
      connection: safeConnectionSelection,
    })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.ownerUserId))
      .leftJoin(projectTokens, eq(projectTokens.projectId, projects.id))
      .where(and(
        eq(projects.id, input.projectId),
        projectReadPredicate(input.userId, input.projectId),
        isNull(users.blockedAt),
      ))
      .orderBy(desc(projectTokens.createdAt), desc(projectTokens.id))
      .limit(input.limit);
    if (rows.length === 0) {
      throw new ConnectionControlError("PROJECT_NOT_FOUND");
    }
    return rows.flatMap(({ connection }) => (
      connection === null ? [] : [publicConnection(connection, now)]
    ));
  }

  async function revoke(input: RevokeConnectionInput): Promise<PublicControlConnection> {
    if (
      !validUuid(input.ownerUserId)
      || !validUuid(input.projectId)
      || !validUuid(input.connectionId)
    ) {
      throw new ConnectionControlError("INVALID_REQUEST");
    }
    return db.transaction(async (transaction) => {
      await lockOwnedProject(transaction, input.ownerUserId, input.projectId);
      const [connection] = await transaction.select(safeConnectionSelection).from(projectTokens)
        .where(and(
          eq(projectTokens.projectId, input.projectId),
          eq(projectTokens.id, input.connectionId),
        )).limit(1).for("update");
      if (connection === undefined) throw new ConnectionControlError("CONNECTION_NOT_FOUND");
      if (connection.revokedAt !== null) {
        throw new ConnectionControlError("CONNECTION_STATE_CONFLICT");
      }
      const now = clock();
      if (!validDate(now)) throw new ConnectionControlError("CONTROL_UNAVAILABLE");

      const [revoked] = await transaction.update(projectTokens).set({ revokedAt: now }).where(and(
        eq(projectTokens.projectId, input.projectId),
        eq(projectTokens.id, input.connectionId),
        isNull(projectTokens.revokedAt),
      )).returning(safeConnectionSelection);
      if (revoked === undefined) throw new ConnectionControlError("CONNECTION_STATE_CONFLICT");

      await audit.record({
        userId: input.ownerUserId,
        projectId: input.projectId,
        eventType: "connection.revoked",
        metadata: { connection_label: revoked.label },
      }, transaction);
      return publicConnection(revoked, now);
    });
  }

  return { issue, list, revoke };
}

export type ConnectionService = ReturnType<typeof createConnectionService>;

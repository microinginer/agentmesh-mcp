import { Buffer } from "node:buffer";

import { z } from "zod";

import { activityEventTypes } from "../activity/types.js";
import { uuidV4Schema } from "../contracts.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CURSOR_BYTES = 512;

export type SequenceCursor = { kind: "sequence"; sequence: number };
export type CreatedCursor = { kind: "created"; created_at: string; id: string };
export type AdminCursor = SequenceCursor | CreatedCursor;

const sequenceCursorSchema = z
  .object({
    kind: z.literal("sequence"),
    sequence: z.number().int().nonnegative(),
  })
  .strict();
const createdCursorSchema = z
  .object({
    kind: z.literal("created"),
    created_at: z.string().datetime({ offset: true }),
    id: uuidV4Schema,
  })
  .strict();
const cursorPayloadSchema = z.discriminatedUnion("kind", [
  sequenceCursorSchema,
  createdCursorSchema,
]);

function decodeCursorValue(value: string): AdminCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid admin cursor");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_CURSOR_BYTES || bytes.toString("base64url") !== value) {
    throw new Error("Invalid admin cursor");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid admin cursor");
  }
  const parsed = cursorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid admin cursor");
  }
  return parsed.data;
}

export function encodeAdminCursor(cursor: AdminCursor): string {
  return Buffer.from(JSON.stringify(cursorPayloadSchema.parse(cursor)), "utf8").toString("base64url");
}

export function decodeAdminCursor(value: string): AdminCursor {
  return decodeCursorValue(value);
}

function cursorSchema(kind: AdminCursor["kind"]) {
  return z.string().min(1).superRefine((value, context) => {
    try {
      if (decodeCursorValue(value).kind !== kind) {
        context.addIssue({ code: "custom", message: "Invalid admin cursor" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Invalid admin cursor" });
    }
  });
}

const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

export const adminListQuerySchema = z
  .object({
    limit: limitSchema,
    cursor: cursorSchema("created").optional(),
  })
  .strict();

function rejectMixedSequencePaging(
  query: { cursor?: string | undefined; after?: string | undefined },
  context: z.RefinementCtx,
) {
  if (query.cursor !== undefined && query.after !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["after"],
      message: "cursor and after cannot be used together",
    });
  }
}

export const messageListQuerySchema = z
  .object({
    agent_id: uuidV4Schema.optional(),
    acknowledged: z.boolean().optional(),
    limit: limitSchema,
    cursor: cursorSchema("sequence").optional(),
    after: cursorSchema("sequence").optional(),
  })
  .strict()
  .superRefine(rejectMixedSequencePaging);

export const eventListQuerySchema = z
  .object({
    agent_id: uuidV4Schema.optional(),
    event_type: z.enum(activityEventTypes).optional(),
    outcome: z.enum(["success", "failure"]).optional(),
    limit: limitSchema,
    cursor: cursorSchema("sequence").optional(),
    after: cursorSchema("sequence").optional(),
  })
  .strict()
  .superRefine(rejectMixedSequencePaging);

export type AdminListQuery = z.output<typeof adminListQuerySchema>;
export type MessageListQuery = z.output<typeof messageListQuerySchema>;
export type EventListQuery = z.output<typeof eventListQuerySchema>;

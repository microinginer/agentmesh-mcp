import { Buffer } from "node:buffer";

import { z } from "zod";

export const MAX_MESSAGE_BYTES = 16 * 1024;

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const agentTokenPattern =
  /^am_agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i;
const profileSlugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const capabilitySlugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export const uuidV4Schema = z.string().regex(uuidV4Pattern, "Expected a UUIDv4");
export const agentTokenSchema = z.string().regex(agentTokenPattern, "Invalid agent token");

const capabilitiesSchema = z
  .array(z.string().regex(capabilitySlugPattern, "Invalid capability slug"))
  .max(16)
  .default([])
  .refine((values) => new Set(values).size === values.length, {
    message: "Capabilities must be unique",
  });

const registerInputSchema = z
  .object({
    mode: z.literal("register"),
    session_instance_id: uuidV4Schema,
    name: z.string().regex(profileSlugPattern, "Invalid agent name"),
    client: z.string().regex(profileSlugPattern, "Invalid client name"),
    capabilities: capabilitiesSchema,
  })
  .strict();

const pollInputSchema = z
  .object({
    mode: z.literal("poll"),
    agent_token: agentTokenSchema,
    acknowledge: z
      .array(uuidV4Schema)
      .max(100)
      .default([])
      .refine((values) => new Set(values).size === values.length, {
        message: "Acknowledgements must be unique",
      }),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const syncInputSchema = z.discriminatedUnion("mode", [
  registerInputSchema,
  pollInputSchema,
]);

export const sendInputSchema = z
  .object({
    agent_token: agentTokenSchema,
    to_agent_id: uuidV4Schema,
    text: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES, {
        message: `Message must be at most ${MAX_MESSAGE_BYTES} UTF-8 bytes`,
      }),
    idempotency_key: uuidV4Schema,
  })
  .strict();

export const listAgentsInputSchema = z
  .object({
    agent_token: agentTokenSchema,
  })
  .strict();

export const publicAgentSchema = z
  .object({
    id: uuidV4Schema,
    name: z.string(),
    client: z.string(),
    capabilities: z.array(z.string()),
    status: z.enum(["online", "idle", "offline"]),
    is_self: z.boolean(),
    last_seen_at: z.string(),
  })
  .strict();

export const inboxMessageSchema = z
  .object({
    id: uuidV4Schema,
    sequence: z.number().int().positive(),
    from_agent_id: uuidV4Schema,
    text: z.string(),
    created_at: z.string(),
  })
  .strict();

export const sentMessageSchema = z
  .object({
    id: uuidV4Schema,
    sequence: z.number().int().positive(),
    from_agent_id: uuidV4Schema,
    to_agent_id: uuidV4Schema,
    text: z.string(),
    created_at: z.string(),
  })
  .strict();

const toolErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum([
          "AGENT_AUTH_INVALID",
          "PROJECT_AUTH_INVALID",
          "REGISTRATION_CONFLICT",
          "TARGET_AGENT_INVALID",
          "IDEMPOTENCY_CONFLICT",
          "INTERNAL_ERROR",
        ]),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

export const syncOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      data: z
        .object({
          mode: z.literal("registered"),
          agent: publicAgentSchema,
          agent_token: agentTokenSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      data: z
        .object({
          mode: z.literal("synced"),
          agent: publicAgentSchema,
          acknowledged: z.number().int().nonnegative(),
          messages: z.array(inboxMessageSchema),
          has_more: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  toolErrorSchema,
]);

export const sendOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      data: z
        .object({
          message: sentMessageSchema,
          deduplicated: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  toolErrorSchema,
]);

export const listAgentsOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      data: z.object({ agents: z.array(publicAgentSchema) }).strict(),
    })
    .strict(),
  toolErrorSchema,
]);

export type SyncInput = z.output<typeof syncInputSchema>;
export type RegisterInput = Extract<SyncInput, { mode: "register" }>;
export type PollInput = Extract<SyncInput, { mode: "poll" }>;
export type SendInput = z.output<typeof sendInputSchema>;
export type ListAgentsInput = z.output<typeof listAgentsInputSchema>;

import { Buffer } from "node:buffer";

import { z } from "zod";

export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_BLACKBOARD_VALUE_BYTES = 64 * 1024;

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

const blackboardNamespaceSchema = z.string().min(1).max(64);
const blackboardKeySchema = z.string().min(1).max(128);
const blackboardTagSchema = z.string().min(1);

const uniqueNonEmptyStringArray = (itemSchema: z.ZodString, maximum: number) =>
  z
    .array(itemSchema)
    .min(1)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: "Values must be unique",
    });

export const blackboardSetFactInputSchema = z
  .object({
    agent_token: agentTokenSchema,
    namespace: blackboardNamespaceSchema,
    key: blackboardKeySchema,
    value: z.string().refine(
      (value) => Buffer.byteLength(value, "utf8") <= MAX_BLACKBOARD_VALUE_BYTES,
      {
        message: `Value must be at most ${MAX_BLACKBOARD_VALUE_BYTES} UTF-8 bytes`,
      },
    ),
    tags: z
      .array(blackboardTagSchema)
      .max(10)
      .default([])
      .refine((values) => new Set(values).size === values.length, {
        message: "Tags must be unique",
      }),
    ttl_seconds: z.number().int().positive().max(2_147_483_647).optional(),
    expected_version: z.number().int().positive().max(2_147_483_647).optional(),
  })
  .strict();

export const blackboardGetFactsInputSchema = z
  .object({
    agent_token: agentTokenSchema,
    namespace: blackboardNamespaceSchema.optional(),
    keys: uniqueNonEmptyStringArray(blackboardKeySchema, 100).optional(),
    tags: uniqueNonEmptyStringArray(blackboardTagSchema, 10).optional(),
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

export const blackboardFactSchema = z
  .object({
    id: uuidV4Schema,
    project_id: uuidV4Schema,
    namespace: z.string(),
    key: z.string(),
    value: z.string(),
    tags: z.array(z.string()),
    version: z.number().int().positive(),
    ttl_seconds: z.number().int().positive().nullable(),
    expires_at: z.iso.datetime().nullable(),
    created_by_type: z.enum(["agent", "user"]),
    created_by_id: uuidV4Schema,
    last_updated_by_type: z.enum(["agent", "user"]),
    last_updated_by_id: uuidV4Schema,
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
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
          "VERSION_CONFLICT",
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

export const blackboardSetFactOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      data: blackboardFactSchema,
    })
    .strict(),
  toolErrorSchema,
]);

export const blackboardGetFactsOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      data: z.object({ facts: z.array(blackboardFactSchema) }).strict(),
    })
    .strict(),
  toolErrorSchema,
]);

export type SyncInput = z.output<typeof syncInputSchema>;
export type RegisterInput = Extract<SyncInput, { mode: "register" }>;
export type PollInput = Extract<SyncInput, { mode: "poll" }>;
export type SendInput = z.output<typeof sendInputSchema>;
export type ListAgentsInput = z.output<typeof listAgentsInputSchema>;
export type BlackboardSetFactInput = z.output<typeof blackboardSetFactInputSchema>;
export type BlackboardGetFactsInput = z.output<typeof blackboardGetFactsInputSchema>;
export type BlackboardFact = z.output<typeof blackboardFactSchema>;

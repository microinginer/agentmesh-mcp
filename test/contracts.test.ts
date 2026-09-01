import { describe, expect, it } from "vitest";

import {
  MAX_BLACKBOARD_VALUE_BYTES,
  MAX_MESSAGE_BYTES,
  blackboardGetFactsInputSchema,
  blackboardSetFactInputSchema,
  listAgentsInputSchema,
  sendInputSchema,
  syncInputSchema,
} from "../src/contracts.js";

const sessionInstanceId = "1b55e221-63a7-41b0-940f-cb37e7d20e50";
const agentId = "f4f74985-fc09-4c1f-ab7e-28871bc66dc9";
const messageId = "e78c8358-3389-4d24-a10e-a0722ab8d890";
const idempotencyKey = "c3b9499a-3c61-4ef5-bfa8-df7cfb6477cc";
const agentToken = `am_agent_${agentId}.${"a".repeat(43)}`;

describe("AgentMesh public input contracts", () => {
  it.each([
    {
      name: "registration",
      schema: syncInputSchema,
      value: {
        mode: "register",
        session_instance_id: sessionInstanceId,
        name: "codex-backend",
        client: "codex",
        capabilities: ["backend", "testing"],
      },
    },
    {
      name: "poll",
      schema: syncInputSchema,
      value: {
        mode: "poll",
        agent_token: agentToken,
        acknowledge: [messageId],
        limit: 50,
      },
    },
    {
      name: "send",
      schema: sendInputSchema,
      value: {
        agent_token: agentToken,
        to_agent_id: agentId,
        text: "Please use the new parser contract.",
        idempotency_key: idempotencyKey,
      },
    },
    {
      name: "agent listing",
      schema: listAgentsInputSchema,
      value: { agent_token: agentToken },
    },
  ])("accepts a valid $name input", ({ schema, value }) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each([
    {
      schema: syncInputSchema,
      value: {
        mode: "register",
        session_instance_id: sessionInstanceId,
        name: "codex",
        client: "codex",
        capabilities: [],
        unexpected: true,
      },
    },
    {
      schema: sendInputSchema,
      value: {
        agent_token: agentToken,
        to_agent_id: agentId,
        text: "hello",
        idempotency_key: idempotencyKey,
        unexpected: true,
      },
    },
    {
      schema: listAgentsInputSchema,
      value: { agent_token: agentToken, unexpected: true },
    },
  ])("rejects unknown keys", ({ schema, value }) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("requires a UUIDv4 session identifier", () => {
    const result = syncInputSchema.safeParse({
      mode: "register",
      session_instance_id: "1b55e221-63a7-11b0-940f-cb37e7d20e50",
      name: "codex",
      client: "codex",
      capabilities: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate capabilities", () => {
    const result = syncInputSchema.safeParse({
      mode: "register",
      session_instance_id: sessionInstanceId,
      name: "codex",
      client: "codex",
      capabilities: ["backend", "backend"],
    });

    expect(result.success).toBe(false);
  });

  it.each([0, 101, 1.5])("rejects the poll limit %s", (limit) => {
    const result = syncInputSchema.safeParse({
      mode: "poll",
      agent_token: agentToken,
      acknowledge: [],
      limit,
    });

    expect(result.success).toBe(false);
  });

  it("measures message size in UTF-8 bytes", () => {
    const atLimit = "é".repeat(MAX_MESSAGE_BYTES / 2);
    const overLimit = `${atLimit}é`;
    const base = {
      agent_token: agentToken,
      to_agent_id: agentId,
      idempotency_key: idempotencyKey,
    };

    expect(sendInputSchema.safeParse({ ...base, text: atLimit }).success).toBe(true);
    expect(sendInputSchema.safeParse({ ...base, text: overLimit }).success).toBe(false);
    expect(sendInputSchema.safeParse({ ...base, text: "" }).success).toBe(false);
  });

  it("validates Blackboard set inputs and measures fact values in UTF-8 bytes", () => {
    const atLimit = "é".repeat(MAX_BLACKBOARD_VALUE_BYTES / 2);
    const base = {
      agent_token: agentToken,
      namespace: "contracts",
      key: "users.v2",
    };

    expect(blackboardSetFactInputSchema.safeParse({
      ...base,
      value: atLimit,
      tags: ["api", "v2"],
      ttl_seconds: 60,
      expected_version: 1,
    }).success).toBe(true);
    expect(blackboardSetFactInputSchema.safeParse({
      ...base,
      value: `${atLimit}é`,
      tags: [],
    }).success).toBe(false);
  });

  it("rejects invalid Blackboard set boundaries", () => {
    const base = {
      agent_token: agentToken,
      namespace: "contracts",
      key: "users.v2",
      value: "GET /api/v2/users",
    };

    for (const value of [
      { ...base, tags: ["api", "api"] },
      { ...base, tags: Array.from({ length: 11 }, (_, index) => `tag-${index}`) },
      { ...base, tags: [], ttl_seconds: 0 },
      { ...base, tags: [], ttl_seconds: 2_147_483_648 },
      { ...base, tags: [], expected_version: 0 },
      { ...base, tags: [], expected_version: 1.5 },
      { ...base, tags: [], expected_version: 2_147_483_648 },
      { ...base, tags: [], unexpected: true },
    ]) {
      expect(blackboardSetFactInputSchema.safeParse(value).success).toBe(false);
    }
  });

  it("validates Blackboard get filters with non-empty unique arrays", () => {
    const base = { agent_token: agentToken, namespace: "contracts" };

    expect(blackboardGetFactsInputSchema.safeParse({
      ...base,
      keys: ["users.v2"],
      tags: ["api", "v2"],
    }).success).toBe(true);

    for (const value of [
      { ...base, keys: [] },
      { ...base, tags: [] },
      { ...base, keys: ["users.v2", "users.v2"] },
      { ...base, tags: ["api", "api"] },
      { ...base, unexpected: true },
    ]) {
      expect(blackboardGetFactsInputSchema.safeParse(value).success).toBe(false);
    }
  });
});

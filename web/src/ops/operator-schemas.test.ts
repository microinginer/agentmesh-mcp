import { describe, expect, it } from "vitest";

import {
  operatorProjectDetailResponseSchema,
  operatorUserDetailResponseSchema,
} from "@/api/schemas";

const user = {
  id: "00000000-0000-4000-8000-000000000010",
  github_user_id: "9100",
  github_login: "target-user",
  display_name: "Target User",
  avatar_url: null,
  blocked_at: null,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T10:00:00.000Z",
  project_count: 2,
  active_project_count: 1,
};

const project = {
  id: "00000000-0000-4000-8000-000000000020",
  name: "Safe metadata project",
  status: "active",
  archived_at: null,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T10:00:00.000Z",
  owner: {
    id: user.id,
    github_user_id: user.github_user_id,
    github_login: user.github_login,
    display_name: user.display_name,
  },
  counts: { agents: 3, messages: 8, connections: 2 },
};

describe("metadata-only operator schemas", () => {
  it("accepts only documented user metadata and rejects credential-derived fields", () => {
    expect(operatorUserDetailResponseSchema.safeParse({ user }).success).toBe(true);
    expect(operatorUserDetailResponseSchema.safeParse({
      user: { ...user, session_digest: "credential-derived-secret" },
    }).success).toBe(false);
  });

  it("accepts project counters but rejects tokens and message content", () => {
    expect(operatorProjectDetailResponseSchema.safeParse({ project }).success).toBe(true);
    expect(operatorProjectDetailResponseSchema.safeParse({
      project: { ...project, token: "am_proj_secret", message_body: "private context" },
    }).success).toBe(false);
  });
});

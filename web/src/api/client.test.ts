import { describe, expect, it, vi } from "vitest";

import { ApiClient, ApiError } from "./client";

const sessionPayload = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    github_id: "101",
    login: "agentmesh-owner",
    display_name: "AgentMesh Owner",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
  },
  operator: false,
  authenticated_at: "2026-08-31T10:00:00.000Z",
  csrf_token: "agentmesh-test-csrf-token-32-bytes-long",
};

describe("same-origin AgentMesh API client", () => {
  it("keeps CSRF in memory, uses one explicit idempotency key, and accepts 204", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(sessionPayload))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient(fetcher);

    await client.loadSession();
    await client.mutate(
      "/api/v1/projects/00000000-0000-4000-8000-000000000010/connections/00000000-0000-4000-8000-000000000020/revoke",
      { method: "POST", idempotencyKey: "00000000-0000-4000-8000-000000000030" },
    );

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/v1/session", expect.objectContaining({
      credentials: "same-origin",
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, expect.stringMatching(/^\/api\/v1\//), expect.objectContaining({
      credentials: "same-origin",
      method: "POST",
      headers: expect.objectContaining({
        "Idempotency-Key": "00000000-0000-4000-8000-000000000030",
        "X-CSRF-Token": "agentmesh-test-csrf-token-32-bytes-long",
      }),
    }));
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("rejects cross-origin paths and never includes raw response bodies in errors", async () => {
    const secret = "am_proj_this-must-never-be-in-an-error";
    const fetcher = vi.fn().mockResolvedValue(new Response(secret, {
      status: 503,
      headers: { "content-type": "text/plain" },
    }));
    const client = new ApiClient(fetcher);

    await expect(client.query(`https://evil.example/api?secret=${secret}`)).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    await expect(client.query("/api/v1/projects")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      expect(String(error)).not.toContain(secret);
      return true;
    });
  });
});

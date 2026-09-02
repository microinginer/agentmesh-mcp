import { describe, expect, it } from "vitest";

import { createPulseService } from "../src/pulse/service.js";

describe("createPulseService aggregation & reporting", () => {
  it("aggregates daily pulse data correctly across developers and connections", async () => {
    const fixedNow = new Date("2026-09-02T15:00:00.000Z");

    const mockReports = [
      {
        id: "rep-1",
        projectId: "proj-1",
        agentId: "agent-1",
        summary: "Created auth routes",
        currentGoal: "Authentication overhaul",
        filesTouched: ["src/auth.ts", "src/routes.ts"],
        testStatus: { passed: 5, failed: 0 },
        state: "in_progress",
        blockerReason: null,
        createdAt: new Date("2026-09-02T10:00:00.000Z"),
      },
      {
        id: "rep-2",
        projectId: "proj-1",
        agentId: "agent-1",
        summary: "Finished unit tests for auth",
        currentGoal: "Authentication overhaul",
        filesTouched: ["test/auth.test.ts"],
        testStatus: { passed: 12, failed: 0 },
        state: "completed",
        blockerReason: null,
        createdAt: new Date("2026-09-02T14:30:00.000Z"),
      },
      {
        id: "rep-3",
        projectId: "proj-1",
        agentId: "agent-2",
        summary: "Encountered migration failure",
        currentGoal: "Database indexes",
        filesTouched: ["src/db/schema.ts"],
        testStatus: { passed: 2, failed: 1 },
        state: "blocked",
        blockerReason: "Postgres deadlock on migration lock table",
        createdAt: new Date("2026-09-02T11:00:00.000Z"),
      },
    ];

    const mockProjectAgents = [
      {
        agent: {
          id: "agent-1",
          projectId: "proj-1",
          name: "claude-fe",
          client: "claude-code",
          capabilities: ["ui"],
          registeredViaTokenId: "tok-1",
          registrationDigest: Buffer.alloc(32),
          lastSeenAt: new Date("2026-09-02T14:58:00.000Z"), // 2 min ago -> online
          createdAt: new Date("2026-09-02T09:00:00.000Z"),
        },
        token: {
          id: "tok-1",
          projectId: "proj-1",
          label: "ivan-macbook",
          tokenDigest: Buffer.alloc(32),
          createdByUserId: "user-1",
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
          createIdempotencyKey: null,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
        user: {
          id: "user-1",
          displayName: "Ivan Ivanov",
          avatarUrl: "https://avatar.url/ivan",
          blockedAt: null,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      },
      {
        agent: {
          id: "agent-2",
          projectId: "proj-1",
          name: "codex-be",
          client: "codex",
          capabilities: ["db"],
          registeredViaTokenId: "tok-2",
          registrationDigest: Buffer.alloc(32),
          lastSeenAt: new Date("2026-09-02T11:00:00.000Z"), // 4 hrs ago -> offline
          createdAt: new Date("2026-09-02T10:30:00.000Z"),
        },
        token: {
          id: "tok-2",
          projectId: "proj-1",
          label: "alexey-devbox",
          tokenDigest: Buffer.alloc(32),
          createdByUserId: "user-2",
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
          createIdempotencyKey: null,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
        user: {
          id: "user-2",
          displayName: "Alexey Smirnov",
          avatarUrl: "https://avatar.url/alexey",
          blockedAt: null,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      },
    ];

    const mockDb: any = {
      select: (_arg?: any) => ({
        from: (_table: any) => ({
          where: () => ({
            orderBy: () => Promise.resolve(mockReports),
          }),
          leftJoin: () => ({
            leftJoin: () => ({
              where: () => Promise.resolve(mockProjectAgents),
            }),
          }),
        }),
      }),
    };

    const pulseService = createPulseService({
      db: mockDb,
      agentService: {
        authenticateAgent: async () => {
          throw new Error("unsupported");
        },
      },
      activity: {
        record: async () => {},
        recordBestEffort: async () => {},
      },
      clock: () => fixedNow,
    });

    const result = await pulseService.getDailyPulse("proj-1", "2026-09-02");

    expect(result.ok).toBe(true);
    expect(result.date).toBe("2026-09-02");
    expect(result.summary.active_agents_count).toBe(2);
    expect(result.summary.active_blockers_count).toBe(1);
    expect(result.summary.unique_files_touched_count).toBe(4);
    expect(result.summary.unique_files_touched).toEqual([
      "src/auth.ts",
      "src/db/schema.ts",
      "src/routes.ts",
      "test/auth.test.ts",
    ]);

    expect(result.developers).toHaveLength(2);
    const ivan = result.developers.find((d) => d.display_name === "Ivan Ivanov");
    expect(ivan).toBeDefined();
    expect(ivan?.connections).toHaveLength(1);
    expect(ivan?.connections[0]?.label).toBe("ivan-macbook");
    expect(ivan?.connections[0]?.agents).toHaveLength(1);
    const claudeAgent = ivan?.connections[0]?.agents[0];
    expect(claudeAgent?.name).toBe("claude-fe");
    expect(claudeAgent?.status).toBe("online");
    expect(claudeAgent?.current_goal).toBe("Authentication overhaul");
    expect(claudeAgent?.latest_progress?.state).toBe("completed");
    expect(claudeAgent?.latest_progress?.summary).toBe("Finished unit tests for auth");
    expect(claudeAgent?.history).toHaveLength(2);

    const alexey = result.developers.find((d) => d.display_name === "Alexey Smirnov");
    expect(alexey).toBeDefined();
    const codexAgent = alexey?.connections[0]?.agents[0];
    expect(codexAgent?.status).toBe("offline");
    expect(codexAgent?.latest_progress?.state).toBe("blocked");
    expect(codexAgent?.latest_progress?.blocker_reason).toBe(
      "Postgres deadlock on migration lock table",
    );
  });
});

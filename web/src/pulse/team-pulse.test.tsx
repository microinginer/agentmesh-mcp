import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DailyPulseResponse } from "@/api/schemas";
import { session, TestApp } from "@/test/render";
import { generateStandupMarkdown } from "./components/standup-export-dialog";

const projectId = "00000000-0000-4000-8000-000000000010";

function requestPath(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  return url.pathname + url.search;
}

function pulseFor(date: string): DailyPulseResponse {
  return {
    ok: true,
    date,
    summary: {
      active_agents_count: 1,
      total_sessions_count: 1,
      active_blockers_count: 1,
      unique_files_touched_count: 1,
      unique_files_touched: ["src/pulse/service.ts"],
    },
    developers: [{
      user_id: session.user.id,
      display_name: session.user.display_name,
      avatar_url: null,
      connections: [{
        connection_id: "00000000-0000-4000-8000-000000000020",
        label: "Main Mac",
        agents: [{
          agent_id: "00000000-0000-4000-8000-000000000030",
          name: "codex-pulse",
          client: "codex",
          status: "online",
          last_seen_at: `${date}T12:00:00.000Z`,
          current_goal: "Ship Team Pulse",
          latest_progress: {
            summary: `Pulse update for ${date}`,
            state: "blocked",
            blocker_reason: "Waiting for review",
            test_status: { passed: 7, failed: 0 },
            files_touched: ["src/pulse/service.ts"],
            reported_at: `${date}T11:55:00.000Z`,
          },
          history: [],
        }],
      }],
    }],
  };
}

describe("TeamPulsePage", () => {
  it("loads the authenticated daily pulse and requests the previous UTC day", async () => {
    const user = userEvent.setup();
    const today = new Date().toISOString().slice(0, 10);
    const previous = new Date(`${today}T00:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const previousDay = previous.toISOString().slice(0, 10);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === "/api/v1/session") return Response.json(session);
      if (path === `/api/v1/projects/${projectId}/pulse?date=${today}`) {
        return Response.json(pulseFor(today));
      }
      if (path === `/api/v1/projects/${projectId}/pulse?date=${previousDay}`) {
        return Response.json(pulseFor(previousDay));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/pulse`]} />);

    expect(await screen.findByRole("heading", { name: "Team Pulse" })).toBeInTheDocument();
    expect(await screen.findByText(`Pulse update for ${today}`)).toBeInTheDocument();
    expect(screen.getAllByText(/Waiting for review/).length).toBeGreaterThan(0);
    expect(screen.getByText("Ship Team Pulse")).toBeInTheDocument();

    await user.click(screen.getByTitle("Previous day"));

    expect(await screen.findByText(`Pulse update for ${previousDay}`)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/pulse?date=${previousDay}`,
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("generateStandupMarkdown", () => {
  it("formats standup markdown correctly with goals, tests, blockers, and files", () => {
    const pulse: DailyPulseResponse = {
      ok: true,
      date: "2026-09-02",
      summary: {
        active_agents_count: 2,
        total_sessions_count: 2,
        active_blockers_count: 1,
        unique_files_touched_count: 3,
        unique_files_touched: ["src/auth.ts", "src/routes.ts", "test/auth.test.ts"],
      },
      developers: [
        {
          user_id: "u-1",
          display_name: "Ivan Ivanov",
          avatar_url: null,
          connections: [
            {
              connection_id: "c-1",
              label: "ivan-macbook",
              agents: [
                {
                  agent_id: "a-1",
                  name: "claude-fe",
                  client: "claude-code",
                  status: "online",
                  last_seen_at: "2026-09-02T14:58:00.000Z",
                  current_goal: "Auth Flow redesign",
                  latest_progress: {
                    summary: "Implemented JWT verification",
                    state: "completed",
                    blocker_reason: null,
                    test_status: { passed: 15, failed: 0 },
                    files_touched: ["src/auth.ts", "test/auth.test.ts"],
                    reported_at: "2026-09-02T14:55:00.000Z",
                  },
                  history: [],
                },
              ],
            },
          ],
        },
        {
          user_id: "u-2",
          display_name: "Alexey Smirnov",
          avatar_url: null,
          connections: [
            {
              connection_id: "c-2",
              label: "alexey-devbox",
              agents: [
                {
                  agent_id: "a-2",
                  name: "codex-be",
                  client: "codex",
                  status: "offline",
                  last_seen_at: "2026-09-02T11:00:00.000Z",
                  current_goal: "Migrations",
                  latest_progress: {
                    summary: "Migration deadlock error",
                    state: "blocked",
                    blocker_reason: "Deadlock on table locks",
                    test_status: { passed: 2, failed: 1 },
                    files_touched: ["src/routes.ts"],
                    reported_at: "2026-09-02T11:00:00.000Z",
                  },
                  history: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const md = generateStandupMarkdown(pulse);

    expect(md).toContain("### 🚀 AI Team Activity Digest (2026-09-02)");
    expect(md).toContain("👤 Ivan Ivanov:");
    expect(md).toContain("claude-fe / claude-code");
    expect(md).toContain("Implemented JWT verification");
    expect(md).toContain("Goal: Auth Flow redesign");
    expect(md).toContain("15 tests passed");
    expect(md).toContain("👤 Alexey Smirnov:");
    expect(md).toContain("⚠️ **BLOCKER:** Deadlock on table locks");
    expect(md).toContain("Total files modified today (3):");
    expect(md).toContain("- `src/auth.ts`");
    expect(md).toContain("- `src/routes.ts`");
    expect(md).toContain("- `test/auth.test.ts`");
  });

  it("handles empty team activity cleanly", () => {
    const emptyPulse: DailyPulseResponse = {
      ok: true,
      date: "2026-09-02",
      summary: {
        active_agents_count: 0,
        total_sessions_count: 0,
        active_blockers_count: 0,
        unique_files_touched_count: 0,
        unique_files_touched: [],
      },
      developers: [],
    };

    const md = generateStandupMarkdown(emptyPulse);
    expect(md).toContain("No agent activity recorded for this day.");
  });
});

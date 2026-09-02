import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DailyPulseResponse } from "@/api/schemas";
import { session, TestApp } from "@/test/render";
import { generateStandupMarkdown } from "./components/standup-export-dialog";

const projectId = "00000000-0000-4000-8000-000000000010";
const activeProject = {
  id: projectId,
  name: "skills-and-mcp",
  description: "AgentMesh collaboration workspace",
  status: "active",
  archived_at: null,
  created_at: "2026-09-01T10:00:00.000Z",
  updated_at: "2026-09-02T10:00:00.000Z",
};

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
            id: "00000000-0000-4000-8000-000000000040",
            summary: `Pulse update for ${date}`,
            state: "blocked",
            blocker_reason: "Waiting for review",
            test_status: { passed: 7, failed: 0 },
            files_touched: ["src/pulse/service.ts"],
            reported_at: `${date}T11:55:00.000Z`,
            resolved_at: null,
            resolution_note: null,
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
      if (path === `/api/v1/projects/${projectId}`) return Response.json({ project: activeProject });
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
    expect(await screen.findAllByRole("button", { name: "Current project: skills-and-mcp" })).toHaveLength(2);
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

  it("contains long progress content inside padded mobile-safe cards", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const longToken = "very-long-unbroken-progress-description-".repeat(8);
    const pulse = pulseFor(today);
    const agent = pulse.developers[0]!.connections[0]!.agents[0]!;
    agent.current_goal = longToken;
    agent.latest_progress!.summary = longToken;
    agent.latest_progress!.files_touched = [`web/src/${longToken}/component.tsx`];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === "/api/v1/session") return Response.json(session);
      if (path === `/api/v1/projects/${projectId}`) return Response.json({ project: activeProject });
      if (path === `/api/v1/projects/${projectId}/pulse?date=${today}`) return Response.json(pulse);
      throw new Error(`Unexpected request: ${path}`);
    }));

    const { container } = render(<TestApp initialEntries={[`/app/projects/${projectId}/pulse`]} />);

    expect(await screen.findByText(longToken, { selector: "span" })).toHaveClass("break-anywhere");
    expect(screen.getByText(longToken, { selector: "p" })).toHaveClass("break-anywhere");
    expect(screen.getByText(`web/src/${longToken}/component.tsx`, { selector: ".max-w-full" })).toHaveClass("break-anywhere", "max-w-full");
    expect(container.querySelector(".team-pulse-page")).toBeInTheDocument();
    expect(container.querySelector(".pulse-agent-card")).toHaveClass("min-w-0", "overflow-hidden");
  });

  it("lets the owner resolve only an offline blocker and keeps the action hidden from viewers", async () => {
    const user = userEvent.setup();
    const today = new Date().toISOString().slice(0, 10);
    const reportId = "00000000-0000-4000-8000-000000000040";
    const pulse = pulseFor(today);
    const agent = pulse.developers[0]!.connections[0]!.agents[0]!;
    agent.status = "offline";
    Object.assign(agent.latest_progress!, {
      id: reportId,
      resolved_at: null,
      resolution_note: null,
    });
    let resolved = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === "/api/v1/session") return Response.json(session);
      if (path === `/api/v1/projects/${projectId}`) {
        return Response.json({ project: { ...activeProject, can_edit: true } });
      }
      if (path === `/api/v1/projects/${projectId}/pulse?date=${today}`) {
        if (resolved) {
          pulse.summary.active_blockers_count = 0;
          Object.assign(agent.latest_progress!, {
            resolved_at: `${today}T12:30:00.000Z`,
            resolution_note: "Covered by the deployed fix",
          });
        }
        return Response.json(pulse);
      }
      if (path === `/api/v1/projects/${projectId}/pulse/blockers/${reportId}/resolve` && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ note: "Covered by the deployed fix" });
        resolved = true;
        return Response.json({
          blocker: {
            id: reportId,
            resolved_at: `${today}T12:30:00.000Z`,
            resolution_note: "Covered by the deployed fix",
          },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const ownerView = render(<TestApp initialEntries={[`/app/projects/${projectId}/pulse`]} />);
    const resolveButton = await screen.findByRole("button", { name: "Resolve blocker for codex-pulse" });
    await user.click(resolveButton);
    expect(screen.getByRole("heading", { name: "Resolve blocker?" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Resolution note (optional)"), "Covered by the deployed fix");
    await user.click(screen.getByRole("button", { name: "Mark resolved" }));
    expect(await screen.findByText("Resolved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve blocker for codex-pulse" })).not.toBeInTheDocument();
    ownerView.unmount();

    resolved = false;
    pulse.summary.active_blockers_count = 1;
    agent.status = "online";
    Object.assign(agent.latest_progress!, { resolved_at: null, resolution_note: null });
    const activeOwnerView = render(<TestApp initialEntries={[`/app/projects/${projectId}/pulse`]} />);
    expect(await screen.findByText("Pulse update for " + today)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve blocker for codex-pulse" })).not.toBeInTheDocument();
    activeOwnerView.unmount();

    agent.status = "offline";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === "/api/v1/session") return Response.json(session);
      if (path === `/api/v1/projects/${projectId}`) {
        return Response.json({ project: { ...activeProject, can_edit: false } });
      }
      if (path === `/api/v1/projects/${projectId}/pulse?date=${today}`) return Response.json(pulse);
      throw new Error(`Viewer attempted unexpected request: ${path}`);
    }));
    render(<TestApp initialEntries={[`/app/projects/${projectId}/pulse`]} />);
    expect(await screen.findByText("Pulse update for " + today)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve blocker for codex-pulse" })).not.toBeInTheDocument();
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
                    id: "00000000-0000-4000-8000-000000000041",
                    summary: "Implemented JWT verification",
                    state: "completed",
                    blocker_reason: null,
                    test_status: { passed: 15, failed: 0 },
                    files_touched: ["src/auth.ts", "test/auth.test.ts"],
                    reported_at: "2026-09-02T14:55:00.000Z",
                    resolved_at: null,
                    resolution_note: null,
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
                    id: "00000000-0000-4000-8000-000000000042",
                    summary: "Migration deadlock error",
                    state: "blocked",
                    blocker_reason: "Deadlock on table locks",
                    test_status: { passed: 2, failed: 1 },
                    files_touched: ["src/routes.ts"],
                    reported_at: "2026-09-02T11:00:00.000Z",
                    resolved_at: null,
                    resolution_note: null,
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

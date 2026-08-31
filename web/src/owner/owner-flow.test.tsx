import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TestApp } from "@/test/render";

const projectId = "00000000-0000-4000-8000-000000000010";
const secondProjectId = "00000000-0000-4000-8000-000000000011";
const connectionA = "00000000-0000-4000-8000-000000000020";
const connectionB = "00000000-0000-4000-8000-000000000021";
const secret = "am_proj_test-only-one-time-secret";

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

const project = {
  id: projectId,
  name: "AgentMesh",
  description: "Shared coordination workspace",
  status: "active",
  archived_at: null,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T10:00:00.000Z",
};

const secondProject = {
  ...project,
  id: secondProjectId,
  name: "Second project",
  description: "Another shared workspace",
};

const activeConnection = (id: string, label: string) => ({
  id,
  label,
  status: "active",
  expires_at: "2026-11-29T10:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
  created_at: "2026-08-31T10:00:00.000Z",
});

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname + new URL(input.url).search;
  const url = new URL(String(input), "http://localhost");
  return url.pathname + url.search;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function error(code: string, status: number) {
  return json({
    error: {
      code,
      message: "Safe server message",
      request_id: "00000000-0000-4000-8000-000000000099",
    },
  }, status);
}

describe("AgentMesh owner vertical slice", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders the accepted public sign-in copy and maps auth failures without reflecting query text", () => {
    render(<TestApp initialEntries={["/?auth_error=%3Cscript%3Egithub%3C%2Fscript%3E"]} />);

    expect(screen.getByRole("heading", { name: "Your agents, working as one." })).toBeInTheDocument();
    expect(screen.getByText("Share project context, coordinate work, and keep every coding agent aligned.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute("href", "/auth/github/start");
    expect(document.body).not.toHaveTextContent("<script>");
  });

  it("distinguishes anonymous and recoverable unavailable session states", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(error("AUTH_REQUIRED", 401))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(json(sessionPayload))
      .mockResolvedValueOnce(json({ projects: [], active_count: 0, project_limit: 5 }));
    vi.stubGlobal("fetch", fetcher);

    const first = render(<TestApp initialEntries={["/app"]} />);
    expect(await screen.findByRole("heading", { name: "Sign in to AgentMesh" })).toBeInTheDocument();
    first.unmount();

    render(<TestApp initialEntries={["/app"]} />);
    expect(await screen.findByRole("heading", { name: "AgentMesh is temporarily unavailable" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
  });

  it("creates the first project with one UUID and opens its overview without a connection dialog", async () => {
    const user = userEvent.setup();
    let createKey: string | null = null;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(sessionPayload);
      if (path === "/api/v1/projects?limit=50" && init?.method !== "POST") {
        return json({ projects: [], active_count: 0, project_limit: 5 });
      }
      if (path === "/api/v1/projects" && init?.method === "POST") {
        createKey = new Headers(init.headers).get("Idempotency-Key");
        return json({ project }, 201);
      }
      if (path === `/api/v1/projects/${projectId}/overview`) {
        return json({ overview: { project, agents: { online: 0, idle: 0, offline: 0, total: 0 }, messages: { total: 0, unacknowledged: 0 }, failures_last_24h: 0 } });
      }
      if (path === `/api/v1/projects/${projectId}/agents?limit=50`) return json({ items: [], next_cursor: null });
      if (path === `/api/v1/projects/${projectId}/events?limit=20`) return json({ items: [], next_cursor: null, has_more: false });
      if (path === `/api/v1/projects/${projectId}/connections?limit=50`) return json({ connections: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={["/app"]} />);
    await user.type(await screen.findByLabelText("Project name"), "AgentMesh");
    await user.type(screen.getByLabelText("Description"), "Shared coordination workspace");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByText("Coordinate agents without stepping on each other.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "New connection" })).not.toBeInTheDocument();
    expect(createKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("uses the project switcher menu for project creation and keeps New project first", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(sessionPayload);
      if (path === `/api/v1/projects/${projectId}`) return json({ project });
      if (path === `/api/v1/projects/${projectId}/connections?limit=50`) return json({ connections: [] });
      if (path === "/api/v1/projects?limit=50") {
        return json({ projects: [project, secondProject], active_count: 2, project_limit: 5 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/connections`]} />);
    expect(await screen.findByRole("heading", { name: "Connections" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "New connection" })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Current project: AgentMesh" })[0]!);
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("New project");
    expect(within(menu).getByRole("menuitem", { name: "Second project" })).toBeInTheDocument();

    await user.click(items[0]!);
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeInTheDocument();
  });

  it("shows project limits in the New project dialog without allowing another create attempt", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(sessionPayload);
      if (path === `/api/v1/projects/${projectId}`) return json({ project });
      if (path === `/api/v1/projects/${projectId}/connections?limit=50`) return json({ connections: [] });
      if (path === "/api/v1/projects?limit=50" && init?.method !== "POST") {
        return json({ projects: [project], active_count: 5, project_limit: 5 });
      }
      if (path === "/api/v1/projects" && init?.method === "POST") return error("INVALID_REQUEST", 400);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/connections`]} />);
    await user.click((await screen.findAllByRole("button", { name: "Current project: AgentMesh" }))[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "New project" }));
    expect(await screen.findByText("5 of 5 active projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  });

  it("opens an existing workspace from the project index instead of showing the Projects page", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(sessionPayload);
      if (path === "/api/v1/projects?limit=50") return json({ projects: [project], active_count: 1, project_limit: 5 });
      if (path === `/api/v1/projects/${projectId}/overview`) {
        return json({ overview: { project, agents: { online: 0, idle: 0, offline: 0, total: 0 }, messages: { total: 0, unacknowledged: 0 }, failures_last_24h: 0 } });
      }
      if (path === `/api/v1/projects/${projectId}/agents?limit=50`) return json({ items: [], next_cursor: null });
      if (path === `/api/v1/projects/${projectId}/events?limit=20`) return json({ items: [], next_cursor: null, has_more: false });
      if (path === `/api/v1/projects/${projectId}/connections?limit=50`) return json({ connections: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={["/app"]} />);

    expect(await screen.findByText("Coordinate agents without stepping on each other.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Projects" })).not.toBeInTheDocument();
  });

  it("switches active projects while preserving the current section", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(sessionPayload);
      if (path === `/api/v1/projects/${projectId}`) return json({ project });
      if (path === `/api/v1/projects/${secondProjectId}`) return json({ project: secondProject });
      if (path === `/api/v1/projects/${projectId}/connections?limit=50`) return json({ connections: [] });
      if (path === `/api/v1/projects/${secondProjectId}/connections?limit=50`) return json({ connections: [] });
      if (path === "/api/v1/projects?limit=50") {
        return json({ projects: [project, secondProject], active_count: 2, project_limit: 5 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/connections`]} />);
    await user.click((await screen.findAllByRole("button", { name: "Current project: AgentMesh" }))[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Second project" }));

    expect((await screen.findAllByRole("button", { name: "Current project: Second project" })).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Connections" })).toBeInTheDocument();
  });

  it("starts independent overview reads together and renders live summary, agents, events, and connections", async () => {
    const requested: string[] = [];
    const resolvers = new Map<string, (response: Response) => void>();
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return Promise.resolve(json(sessionPayload));
      requested.push(path);
      return new Promise<Response>((resolve) => resolvers.set(path, resolve));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}`]} />);
    await waitFor(() => expect(requested).toEqual(expect.arrayContaining([
      `/api/v1/projects/${projectId}/overview`,
      `/api/v1/projects/${projectId}/agents?limit=50`,
      `/api/v1/projects/${projectId}/events?limit=20`,
      `/api/v1/projects/${projectId}/connections?limit=50`,
    ])));
    resolvers.get(`/api/v1/projects/${projectId}/overview`)?.(json({
      overview: {
        project,
        agents: { online: 2, idle: 1, offline: 0, total: 3 },
        messages: { total: 12, unacknowledged: 2 },
        failures_last_24h: 1,
      },
    }));
    resolvers.get(`/api/v1/projects/${projectId}/agents?limit=50`)?.(json({
      items: [{
        id: "00000000-0000-4000-8000-000000000040",
        name: "Main Mac / Codex",
        client: "codex",
        capabilities: ["messages"],
        created_at: "2026-08-31T09:00:00.000Z",
        status: "online",
        last_seen_at: "2026-08-31T09:59:00.000Z",
        connection: { id: connectionA, label: "Main Mac", status: "active", expires_at: null, revoked_at: null },
      }],
      next_cursor: null,
    }));
    resolvers.get(`/api/v1/projects/${projectId}/events?limit=20`)?.(json({
      items: [{
        sequence: 1,
        id: "00000000-0000-4000-8000-000000000050",
        request_id: "00000000-0000-4000-8000-000000000051",
        event_type: "connection.created",
        outcome: "success",
        actor: null,
        target: null,
        message_id: null,
        error_code: null,
        metadata: { connection_label: "Main Mac" },
        created_at: "2026-08-31T09:58:00.000Z",
      }],
      next_cursor: null,
      has_more: false,
    }));
    resolvers.get(`/api/v1/projects/${projectId}/connections?limit=50`)?.(json({
      connections: [activeConnection(connectionA, "Main Mac")],
    }));

    expect(await screen.findByText("2 online")).toBeInTheDocument();
    expect(screen.getByText("Main Mac / Codex")).toBeInTheDocument();
    expect(screen.getByText("Connection created")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage connections" })).toBeInTheDocument();
  });

  it("keeps a one-time token only while its titled dialog is open and handles unavailable copy", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard unavailable"));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(sessionPayload);
      if (path === `/api/v1/projects/${projectId}`) return json({ project });
      if (path === `/api/v1/projects/${projectId}/connections?limit=50`) return json({ connections: [] });
      if (path === `/api/v1/projects/${projectId}/connections` && init?.method === "POST") {
        return json({ connection: activeConnection(connectionA, "Main Mac"), secret, secret_recoverable: true }, 201);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/connections`]} />);
    await user.click(await screen.findByRole("button", { name: "New connection" }));
    await user.type(screen.getByLabelText("Connection label"), "Main Mac");
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    const dialog = await screen.findByRole("dialog", { name: "Connection created" });
    expect(within(dialog).getByText(secret)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Copy token" }));
    expect(within(dialog).getByText("Copy is unavailable. Select and copy the token manually.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect([...Array(window.localStorage.length)].map((_, index) => window.localStorage.key(index)).join()).toBe("agentmesh-theme");
    expect(JSON.stringify(window.history.state)).not.toContain(secret);
  });

  it("explains a replayed lost secret and revokes one connection without removing another", async () => {
    const user = userEvent.setup();
    const first = activeConnection(connectionA, "Main Mac");
    const second = activeConnection(connectionB, "Second PC");
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(sessionPayload);
      if (path === `/api/v1/projects/${projectId}`) return json({ project });
      if (path === `/api/v1/projects/${projectId}/connections?limit=50`) return json({ connections: [first, second] });
      if (path === `/api/v1/projects/${projectId}/connections` && init?.method === "POST") {
        return json({ connection: first, secret: null, secret_recoverable: false }, 201);
      }
      if (path === `/api/v1/projects/${projectId}/connections/${connectionA}/revoke` && init?.method === "POST") {
        return json({ connection: { ...first, status: "revoked", revoked_at: "2026-08-31T11:00:00.000Z" } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/connections`]} />);
    await user.click(await screen.findByRole("button", { name: "New connection" }));
    await user.type(screen.getByLabelText("Connection label"), "Main Mac");
    await user.click(screen.getByRole("button", { name: "Create connection" }));
    expect(await screen.findByText("This token cannot be recovered. Revoke and recreate the connection.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));

    const firstRow = screen.getByRole("listitem", { name: "Main Mac connection" });
    const secondRow = screen.getByRole("listitem", { name: "Second PC connection" });
    await user.click(within(firstRow).getByRole("button", { name: "Revoke Main Mac" }));
    await waitFor(() => expect(within(firstRow).getAllByText("Revoked").length).toBeGreaterThanOrEqual(1));
    expect(within(secondRow).getByText("Active")).toBeInTheDocument();
  });
});

import { describe, expect, it } from "vitest";

import { ADMIN_BROWSER_SOURCE, nextPollDelay, newestSequence, type PollState } from "../src/admin/ui/browser.js";
import { ADMIN_STYLES } from "../src/admin/ui/styles.js";
import { renderAdminPage } from "../src/admin/ui/page.js";

describe("local admin dashboard page", () => {
  it("renders the authenticated dashboard shell with nonce-bound assets and no credential", () => {
    const nonce = "test-nonce";
    const adminToken = "admin-token-must-never-appear";
    const page = renderAdminPage({ authenticated: true, nonce });

    expect(page.body).toContain(`nonce="${nonce}"`);
    expect(page.body).toContain('id="project-selector"');
    expect(page.body).toContain('aria-live="polite"');
    expect(page.body).toContain('data-state="connecting"');
    expect(page.body).toContain("Connecting…");
    expect(page.body).toContain('data-tab="activity"');
    expect(page.body).toContain('data-tab="messages"');
    expect(page.body).toContain('data-tab="agents"');
    expect(page.body).toContain('id="summary"');
    expect(page.body).toContain('id="summary-agents-online"');
    expect(page.body).toContain('id="summary-agents-idle"');
    expect(page.body).toContain('id="summary-agents-offline"');
    expect(page.body).toContain('id="summary-agents-total"');
    expect(page.body).toContain('id="summary-messages-total"');
    expect(page.body).toContain('id="summary-messages-unacknowledged"');
    expect(page.body).toContain('id="filters"');
    expect(page.body).toContain('id="data-view"');
    expect(page.body).toContain('id="detail-drawer"');
    expect(page.body).toContain('id="logout-button"');
    expect(page.body).not.toContain(adminToken);
    expect(page.contentSecurityPolicy).toBe(
      "default-src 'none'; script-src 'nonce-test-nonce'; style-src 'nonce-test-nonce'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(ADMIN_STYLES).toContain(":focus-visible");
    expect(ADMIN_STYLES).toContain("prefers-color-scheme");
  });

  it("renders a credential-only login page with JSON interception and no app data mounts", () => {
    const page = renderAdminPage({ authenticated: false, nonce: "test-nonce" });

    expect(page.body).toContain('id="login-form"');
    expect(page.body).toContain('type="password"');
    expect(page.body).not.toContain('id="project-selector"');
    expect(page.body).not.toContain('id="summary"');
    expect(page.body).not.toContain('id="data-view"');
    expect(ADMIN_BROWSER_SOURCE).toContain("application/json");
  });
});

describe("dashboard polling helpers", () => {
  it("uses one-second visible polling, slower hidden polling, bounded failure backoff, and resets after success", () => {
    const ready: PollState = { visible: true, failures: 0 };

    expect(nextPollDelay(ready)).toBe(1_000);
    expect(nextPollDelay({ visible: false, failures: 0 })).toBe(15_000);
    expect(nextPollDelay({ visible: true, failures: 1 })).toBe(1_000);
    expect(nextPollDelay({ visible: true, failures: 2 })).toBe(2_000);
    expect(nextPollDelay({ visible: true, failures: 3 })).toBe(4_000);
    expect(nextPollDelay({ visible: true, failures: 4 })).toBe(8_000);
    expect(nextPollDelay({ visible: true, failures: 5 })).toBe(15_000);
    expect(nextPollDelay({ visible: true, failures: 99 })).toBe(15_000);
    expect(nextPollDelay({ visible: true, failures: 0 })).toBe(1_000);
  });

  it("keeps the newest accepted sequence while incremental pages are drained", () => {
    expect(newestSequence(12, [{ sequence: 13 }, { sequence: 18 }])).toBe(18);
    expect(newestSequence(18, [])).toBe(18);
  });
});

describe("dashboard browser safety", () => {
  it("renders remote values as text without persistent browser storage", () => {
    expect(ADMIN_BROWSER_SOURCE).toContain("document.createElement");
    expect(ADMIN_BROWSER_SOURCE).toContain("textContent");
    expect(ADMIN_BROWSER_SOURCE).not.toMatch(/innerHTML\s*=/);
    expect(ADMIN_BROWSER_SOURCE).not.toContain("localStorage");
    expect(ADMIN_BROWSER_SOURCE).not.toContain("sessionStorage");
  });
});

type FetchOptions = { body?: string; headers?: Record<string, string>; method?: string } | undefined;
type FetchLog = { options: FetchOptions; url: string };
type FetchReply = { json: () => Promise<unknown>; ok: boolean; status: number };
type FetchHandler = (url: string, options: FetchOptions) => Promise<FetchReply>;

class FakeNode {
  readonly children: FakeNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Array<(event: { currentTarget: FakeNode; preventDefault: () => void }) => unknown>>();
  className = "";
  hidden = false;
  name = "";
  textContent = "";
  type = "";
  value = "";

  constructor(readonly id = "") {}

  get firstChild(): FakeNode | undefined {
    return this.children[0];
  }

  addEventListener(type: string, listener: (event: { currentTarget: FakeNode; preventDefault: () => void }) => unknown) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ currentTarget: this, preventDefault() {} });
    }
  }

  focus() {}

  querySelectorAll(selector: string): FakeNode[] {
    if (selector !== "select") return [];
    return this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]).filter((child) => child.name !== "");
  }

  removeChild(node: FakeNode) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
  }

  setAttribute() {}
}

function success(data: unknown, status = 200): FetchReply {
  return { ok: true, status, json: async () => data };
}

function failure(status = 503): FetchReply {
  return { ok: false, status, json: async () => ({}) };
}

function dashboardReply(projectId: string) {
  return {
    agents: { items: [], next_cursor: null },
    events: { has_more: false, items: [] },
    messages: { has_more: false, items: [] },
    projects: { items: [{ id: projectId, name: projectId }], next_cursor: null },
    summary: {
      agents: { idle: 0, offline: 0, online: 0, total: 0 },
      failures_last_24h: 0,
      messages: { total: 0, unacknowledged: 0 },
      project: { id: projectId, name: projectId },
    },
  };
}

// oxlint-disable-next-line unicorn/consistent-function-scoping -- Generic deferred test fixture must retain its type parameter.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function decodeSequenceCursor(value: string): number {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { kind: string; sequence: number };
  expect(parsed.kind).toBe("sequence");
  return parsed.sequence;
}

function allText(node: FakeNode): string {
  return node.textContent + node.children.map(allText).join("");
}

function createControllerHarness(handler: FetchHandler, login = false) {
  const nodes = new Map<string, FakeNode>();
  const make = (id: string) => {
    const node = new FakeNode(id);
    nodes.set(id, node);
    return node;
  };
  const app = login ? null : make("app");
  const tabs = login ? [] : ["activity", "messages", "agents"].map((tab) => {
    const node = new FakeNode();
    node.dataset.tab = tab;
    return node;
  });
  for (const id of login
    ? ["login-form", "login-token", "login-error"]
    : ["project-selector", "connection-status", "summary-project", "summary-agents-online", "summary-agents-idle", "summary-agents-offline", "summary-agents-total", "summary-messages-total", "summary-messages-unacknowledged", "summary-failures", "filters", "data-view", "detail-drawer", "drawer-title", "drawer-text", "drawer-close", "logout-button", "new-activity"]) make(id);
  const documentListeners = new Map<string, Array<() => void>>();
  let hidden = false;
  const document = {
    addEventListener(type: string, listener: () => void) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    createElement: () => new FakeNode(),
    get hidden() { return hidden; },
    getElementById: (id: string) => nodes.get(id) ?? null,
    querySelectorAll: (selector: string) => selector === "[role=tab]" ? tabs : [],
  };
  const calls: FetchLog[] = [];
  const timers: Array<{ delay: number; id: number; run: () => unknown }> = [];
  let nextTimerId = 0;
  let reloaded = false;
  const window = {
    clearTimeout(id: number) { const index = timers.findIndex((timer) => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    location: { reload: () => { reloaded = true; } },
    scrollTo() {},
    scrollY: 0,
    setTimeout(run: () => unknown, delay: number) { nextTimerId += 1; timers.push({ delay, id: nextTimerId, run }); return nextTimerId; },
  };
  const fetch = async (url: string, options: FetchOptions) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  new Function("document", "fetch", "window", "URLSearchParams", ADMIN_BROWSER_SOURCE)(document, fetch, window, URLSearchParams);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Harness API intentionally exposes this deterministic microtask drain.
  const settle = async () => { for (let index = 0; index < 48; index += 1) await Promise.resolve(); };
  const runTimer = async () => { const timer = timers.shift(); if (timer !== undefined) timer.run(); await settle(); };
  return {
    app,
    calls,
    dispatchVisibility(nextHidden: boolean) { hidden = nextHidden; for (const listener of documentListeners.get("visibilitychange") ?? []) listener(); },
    node: (id: string) => nodes.get(id) as FakeNode,
    reloaded: () => reloaded,
    runTimer,
    settle,
    tab: (name: string) => tabs.find((tab) => tab.dataset.tab === name) as FakeNode,
    timers,
    window,
  };
}

describe("dashboard browser controller", () => {
  it("drains every opaque project and agent page with an explicit maximum page size", async () => {
    const projects = Array.from({ length: 101 }, (_, index) => ({ id: `project-${index + 1}`, name: `Project ${index + 1}` }));
    const agents = Array.from({ length: 101 }, (_, index) => ({
      capabilities: ["plan", `cap-${index + 1}`],
      client: "codex",
      created_at: "2026-08-30T10:00:00.000Z",
      id: `agent-${index + 1}`,
      last_seen_at: "2026-08-31T00:00:00.000Z",
      name: `Agent ${index + 1}`,
      status: "online",
    }));
    const base = dashboardReply(projects[0]!.id);
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") {
        return request.searchParams.has("cursor")
          ? success({ items: projects.slice(100), next_cursor: null })
          : success({ items: projects.slice(0, 100), next_cursor: "projects-page-2" });
      }
      if (request.pathname.endsWith("/summary")) return success(base.summary);
      if (request.pathname.endsWith("/agents")) {
        return request.searchParams.has("cursor")
          ? success({ items: agents.slice(100), next_cursor: null })
          : success({ items: agents.slice(0, 100), next_cursor: "agents-page-2" });
      }
      return success(base.events);
    });

    await harness.settle();
    expect(harness.node("project-selector").children).toHaveLength(101);
    expect(harness.node("filters").querySelectorAll("select")[0]?.children).toHaveLength(102);
    expect(harness.calls.filter((call) => call.url.includes("limit=100"))).toHaveLength(4);

    harness.tab("agents").dispatch("click");
    await harness.settle();
    expect(allText(harness.node("data-view"))).toContain("Agent 101");
    expect(allText(harness.node("data-view"))).toContain("plan, cap-101");
    expect(allText(harness.node("data-view"))).toContain("Registered");
  });

  it("stops stale project pagination before it can overwrite the current context", async () => {
    const secondPage = deferred<FetchReply>();
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") {
        return request.searchParams.has("cursor")
          ? secondPage.promise
          : success({ items: [{ id: "project-a", name: "Project A" }], next_cursor: "page-2" });
      }
      return success(dashboardReply("project-a").events);
    });

    await harness.settle();
    harness.tab("agents").dispatch("click");
    secondPage.resolve(success({ items: [{ id: "stale-project", name: "Stale" }], next_cursor: null }));
    await harness.settle();

    expect(harness.node("project-selector").children).toHaveLength(0);
  });

  it.each(["repeated cursor", "empty progress"])("disconnects on invalid project pagination: %s", async (failureMode) => {
    let requests = 0;
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname !== "/api/admin/projects") return success(dashboardReply("project-a").events);
      requests += 1;
      if (requests === 1) return success({ items: [{ id: "project-a", name: "Project A" }], next_cursor: "stalled" });
      return failureMode === "repeated cursor"
        ? success({ items: [{ id: "project-b", name: "Project B" }], next_cursor: "stalled" })
        : success({ items: [], next_cursor: "different-but-not-progress" });
    });

    await harness.settle();

    expect(requests).toBe(2);
    expect(harness.node("connection-status").textContent).toBe("Disconnected");
    expect(harness.node("project-selector").children).toHaveLength(0);
  });

  it("refreshes summary and complete agent presence while Agents is active", async () => {
    const base = dashboardReply("project-a");
    let refresh = false;
    const onlineAgent = { capabilities: ["plan"], client: "codex", created_at: "2026-08-30T10:00:00.000Z", id: "agent-a", last_seen_at: "2026-08-31T00:00:00.000Z", name: "Agent A", status: "online" };
    const idleAgent = { ...onlineAgent, last_seen_at: "2026-08-30T23:50:00.000Z", status: "idle" };
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return success({ ...base.summary, agents: refresh ? { idle: 1, offline: 0, online: 0, total: 1 } : { idle: 0, offline: 0, online: 1, total: 1 } });
      if (request.pathname.endsWith("/agents")) return success({ items: [refresh ? idleAgent : onlineAgent], next_cursor: null });
      return success(base.events);
    });

    await harness.settle();
    harness.tab("agents").dispatch("click");
    await harness.settle();
    refresh = true;
    await harness.runTimer();

    expect(harness.node("summary-agents-online").textContent).toBe("0");
    expect(harness.node("summary-agents-idle").textContent).toBe("1");
    expect(allText(harness.node("data-view"))).toContain("idle");
  });

  it("marks an Agents-tab polling outage disconnected and preserves the old rows", async () => {
    const base = dashboardReply("project-a");
    const agent = { capabilities: ["plan"], client: "codex", created_at: "2026-08-30T10:00:00.000Z", id: "agent-a", last_seen_at: "2026-08-31T00:00:00.000Z", name: "Old Agent", status: "online" };
    let outage = false;
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return outage ? failure() : success(base.summary);
      if (request.pathname.endsWith("/agents")) return success({ items: [agent], next_cursor: null });
      return success(base.events);
    });

    await harness.settle();
    harness.tab("agents").dispatch("click");
    await harness.settle();
    outage = true;
    await harness.runTimer();

    expect(harness.node("connection-status").textContent).toBe("Disconnected");
    expect(allText(harness.node("data-view"))).toContain("Old Agent");
  });

  it("does not let successful stale agent pagination overwrite the new project", async () => {
    const projectA = dashboardReply("project-a");
    const projectB = dashboardReply("project-b");
    const stalePage = deferred<FetchReply>();
    let aAgentRequests = 0;
    const agentA = { capabilities: ["old"], client: "codex", created_at: "2026-08-30T10:00:00.000Z", id: "agent-a", last_seen_at: "2026-08-31T00:00:00.000Z", name: "Agent A", status: "online" };
    const agentB = { ...agentA, capabilities: ["current"], id: "agent-b", name: "Agent B" };
    const staleAgent = { ...agentA, id: "agent-stale", name: "Stale Agent" };
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success({ items: [{ id: "project-a", name: "Project A" }, { id: "project-b", name: "Project B" }], next_cursor: null });
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/summary")) return success(projectA.summary);
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/agents")) {
        aAgentRequests += 1;
        if (aAgentRequests === 1) return success({ items: [agentA], next_cursor: null });
        return request.searchParams.has("cursor") ? stalePage.promise : success({ items: [agentA], next_cursor: "stale-page" });
      }
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/summary")) return success(projectB.summary);
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/agents")) return success({ items: [agentB], next_cursor: null });
      return success({ has_more: false, items: [] });
    });

    await harness.settle();
    harness.tab("agents").dispatch("click");
    await harness.settle();
    await harness.runTimer();
    harness.node("project-selector").value = "project-b";
    harness.node("project-selector").dispatch("change");
    await harness.settle();
    stalePage.resolve(success({ items: [staleAgent], next_cursor: null }));
    await harness.settle();

    expect(harness.node("summary-project").textContent).toBe("project-b");
    expect(allText(harness.node("data-view"))).toContain("Agent B");
    expect(allText(harness.node("data-view"))).not.toContain("Stale Agent");
  });

  it("renders every summary field and opens a text-only safe event detail drawer", async () => {
    const base = dashboardReply("project-a");
    base.summary.agents = { idle: 2, offline: 3, online: 1, total: 6 };
    base.summary.messages = { total: 8, unacknowledged: 4 };
    base.summary.failures_last_24h = 5;
    const event = { actor: { id: "agent-a", name: "<Actor>" }, created_at: "2026-08-31T00:00:00.000Z", error_code: "invalid_request", event_type: "message.send_failed", id: "event-a", message_id: null, metadata: { operation: "<script>alert(1)</script>" }, outcome: "failure", request_id: "request-a", secret: "must-not-render", sequence: 12, target: null };
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return success(base.summary);
      if (request.pathname.endsWith("/agents")) return success(base.agents);
      return success({ has_more: false, items: [event] });
    });

    await harness.settle();
    expect([
      harness.node("summary-agents-online").textContent,
      harness.node("summary-agents-idle").textContent,
      harness.node("summary-agents-offline").textContent,
      harness.node("summary-agents-total").textContent,
      harness.node("summary-messages-total").textContent,
      harness.node("summary-messages-unacknowledged").textContent,
      harness.node("summary-failures").textContent,
    ]).toEqual(["1", "2", "3", "6", "8", "4", "5"]);
    const eventButton = harness.node("data-view").children[0]?.children[1]?.children[0]?.children[0]?.children[0];
    eventButton?.dispatch("click");
    expect(harness.node("drawer-title").textContent).toBe("Event details");
    expect(harness.node("drawer-text").textContent).toContain('"error_code": "invalid_request"');
    expect(harness.node("drawer-text").textContent).toContain("<script>alert(1)</script>");
    expect(harness.node("drawer-text").textContent).not.toContain("must-not-render");
    expect(harness.node("detail-drawer").hidden).toBe(false);
  });

  it("prepends multi-row activity and message batches newest first", async () => {
    const base = dashboardReply("project-a");
    const initialEvent = { actor: null, created_at: "2026-08-31T00:00:00.000Z", event_type: "event-10", id: "event-10", outcome: "success", sequence: 10 };
    const initialMessage = { acknowledged_at: null, created_at: "2026-08-31T00:00:00.000Z", id: "message-10", recipient: { name: "recipient" }, sender: { name: "sender" }, sequence: 10 };
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return success(base.summary);
      if (request.pathname.endsWith("/agents")) return success(base.agents);
      if (request.pathname.endsWith("/messages")) return request.searchParams.has("after")
        ? success({ has_more: false, items: [{ ...initialMessage, id: "message-11", sequence: 11 }, { ...initialMessage, id: "message-12", sequence: 12 }] })
        : success({ has_more: false, items: [initialMessage] });
      return request.searchParams.has("after")
        ? success({ has_more: false, items: [{ ...initialEvent, event_type: "event-11", id: "event-11", sequence: 11 }, { ...initialEvent, event_type: "event-12", id: "event-12", sequence: 12 }] })
        : success({ has_more: false, items: [initialEvent] });
    });

    await harness.settle();
    await harness.runTimer();
    const activityText = allText(harness.node("data-view"));
    expect(activityText.indexOf("event-12")).toBeLessThan(activityText.indexOf("event-11"));

    harness.tab("messages").dispatch("click");
    await harness.settle();
    await harness.runTimer();
    const messageText = allText(harness.node("data-view"));
    expect(messageText.indexOf("message-12")).toBeLessThan(messageText.indexOf("message-11"));
  });

  it("encodes opaque cursors and commits the newest sequence only after draining incremental pages", async () => {
    const base = dashboardReply("project-a");
    const after: string[] = [];
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return success(base.summary);
      if (request.pathname.endsWith("/agents")) return success(base.agents);
      const cursor = request.searchParams.get("after");
      if (cursor === null) return success({ has_more: false, items: [{ actor: null, created_at: "2026-08-31T00:00:00.000Z", event_type: "agent.synced", id: "event-12", outcome: "success", sequence: 12 }] });
      after.push(cursor);
      const sequence = /^\d+$/.test(cursor) ? Number(cursor) : decodeSequenceCursor(cursor);
      if (sequence === 12) return success({ has_more: true, items: [{ actor: null, created_at: "2026-08-31T00:00:01.000Z", event_type: "agent.synced", id: "event-13", outcome: "success", sequence: 13 }] });
      if (sequence === 13) return success({ has_more: false, items: [{ actor: null, created_at: "2026-08-31T00:00:02.000Z", event_type: "agent.synced", id: "event-14", outcome: "success", sequence: 14 }] });
      return success({ has_more: false, items: [] });
    });

    await harness.settle();
    await harness.runTimer();
    await harness.runTimer();

    expect(after.map(decodeSequenceCursor)).toEqual([12, 13, 14]);
  });

  it("polls activity while Messages is visible and applies a matching acknowledgement", async () => {
    const base = dashboardReply("project-a");
    const message = { acknowledged_at: null, created_at: "2026-08-31T00:00:00.000Z", id: "message-a", recipient: { name: "recipient" }, sender: { name: "sender" }, sequence: 12 };
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return success(base.summary);
      if (request.pathname.endsWith("/agents")) return success(base.agents);
      if (request.pathname.endsWith("/messages")) return success({ has_more: false, items: [message] });
      if (request.searchParams.has("after")) return success({ has_more: false, items: [{ created_at: "2026-08-31T00:00:03.000Z", event_type: "message.acknowledged", message_id: "message-a", sequence: 13 }] });
      return success({ has_more: false, items: [] });
    });

    await harness.settle();
    harness.tab("messages").dispatch("click");
    await harness.settle();
    await harness.runTimer();

    expect(harness.calls.some((call) => new URL(call.url, "http://localhost").pathname.endsWith("/events") && new URL(call.url, "http://localhost").searchParams.has("after"))).toBe(true);
    expect(allText(harness.node("data-view"))).toContain("Acknowledged");
  });

  it("retries initial project loading and only reports connected after recovery", async () => {
    const base = dashboardReply("project-a");
    let attempts = 0;
    const harness = createControllerHarness(async (url) => {
      if (new URL(url, "http://localhost").pathname === "/api/admin/projects") {
        attempts += 1;
        return attempts === 1 ? failure() : success(base.projects);
      }
      if (new URL(url, "http://localhost").pathname.endsWith("/summary")) return success(base.summary);
      if (new URL(url, "http://localhost").pathname.endsWith("/agents")) return success(base.agents);
      return success(base.events);
    });

    await harness.settle();
    expect(harness.node("connection-status").textContent).toBe("Disconnected");
    expect(harness.timers[0]?.delay).toBe(1_000);
    await harness.runTimer();

    expect(attempts).toBe(2);
    expect(harness.node("connection-status").textContent).toBe("Connected");
  });

  it("retries the complete project load when summary data fails after project selection", async () => {
    const base = dashboardReply("project-a");
    let summaries = 0;
    let initialViews = 0;
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) {
        summaries += 1;
        return summaries === 1 ? failure() : success(base.summary);
      }
      if (request.pathname.endsWith("/agents")) return success(base.agents);
      initialViews += 1;
      return success(base.events);
    });

    await harness.settle();
    expect(harness.node("connection-status").textContent).toBe("Disconnected");
    expect(harness.node("summary-project").textContent).toBe("");
    await harness.runTimer();

    expect(summaries).toBe(2);
    expect(initialViews).toBe(2);
    expect(harness.node("connection-status").textContent).toBe("Connected");
  });

  it("discards a stale project response instead of rendering it into the new project", async () => {
    const projectA = dashboardReply("project-a");
    const projectB = dashboardReply("project-b");
    const summaryA = deferred<FetchReply>();
    const agentsA = deferred<FetchReply>();
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success({ items: [{ id: "project-a", name: "project-a" }, { id: "project-b", name: "project-b" }], next_cursor: null });
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/summary")) return summaryA.promise;
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/agents")) return agentsA.promise;
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/summary")) return success(projectB.summary);
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/agents")) return success(projectB.agents);
      return success(projectB.events);
    });

    await harness.settle();
    harness.node("project-selector").value = "project-b";
    harness.node("project-selector").dispatch("change");
    await harness.settle();
    summaryA.resolve(success(projectA.summary));
    agentsA.resolve(success(projectA.agents));
    await harness.settle();

    expect(harness.node("summary-project").textContent).toBe("project-b");
  });

  it("ignores a stale rejected project request after the next project has loaded", async () => {
    const projectB = dashboardReply("project-b");
    const summaryA = deferred<FetchReply>();
    const agentsA = deferred<FetchReply>();
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success({ items: [{ id: "project-a", name: "project-a" }, { id: "project-b", name: "project-b" }], next_cursor: null });
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/summary")) return summaryA.promise;
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/agents")) return agentsA.promise;
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/summary")) return success(projectB.summary);
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/agents")) return success(projectB.agents);
      return success(projectB.events);
    });

    await harness.settle();
    harness.node("project-selector").value = "project-b";
    harness.node("project-selector").dispatch("change");
    await harness.settle();
    summaryA.reject(new Error("stale project failure"));
    agentsA.resolve(success({ items: [] }));
    await harness.settle();

    expect(harness.node("summary-project").textContent).toBe("project-b");
    expect(harness.node("connection-status").textContent).toBe("Connected");
  });

  it("does not let a stale polling rejection flip the current project status", async () => {
    const projectA = dashboardReply("project-a");
    const projectB = dashboardReply("project-b");
    const pollA = deferred<FetchReply>();
    let activityRequests = 0;
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success({ items: [{ id: "project-a", name: "project-a" }, { id: "project-b", name: "project-b" }], next_cursor: null });
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/summary")) return success(projectA.summary);
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/agents")) return success(projectA.agents);
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/events")) {
        activityRequests += 1;
        return activityRequests === 1 ? success(projectA.events) : pollA.promise;
      }
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/summary")) return success(projectB.summary);
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/agents")) return success(projectB.agents);
      return success(projectB.events);
    });

    await harness.settle();
    await harness.runTimer();
    harness.node("project-selector").value = "project-b";
    harness.node("project-selector").dispatch("change");
    await harness.settle();
    pollA.reject(new Error("stale poll failure"));
    await harness.settle();

    expect(harness.node("summary-project").textContent).toBe("project-b");
    expect(harness.node("connection-status").textContent).toBe("Connected");
  });

  it("clears pending activity on tab and filter context changes", async () => {
    const base = dashboardReply("project-a");
    let activitySequence = 12;
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return success(base.summary);
      if (request.pathname.endsWith("/agents")) return success(base.agents);
      if (request.pathname.endsWith("/messages")) return success(base.messages);
      activitySequence += 1;
      return success({ has_more: false, items: [{ actor: null, created_at: "2026-08-31T00:00:00.000Z", event_type: "agent.synced", id: "event-" + activitySequence, outcome: "success", sequence: activitySequence }] });
    });

    await harness.settle();
    harness.window.scrollY = 120;
    await harness.runTimer();
    expect(harness.node("new-activity").hidden).toBe(false);
    harness.tab("messages").dispatch("click");
    await harness.settle();
    expect(harness.node("new-activity").hidden).toBe(true);
    await harness.runTimer();
    expect(harness.node("new-activity").hidden).toBe(false);
    const filter = harness.node("filters").children[0]?.children[0];
    filter?.dispatch("change");
    await harness.settle();
    expect(harness.node("new-activity").hidden).toBe(true);
  });

  it("clears the old project immediately while a replacement load is pending", async () => {
    const projectA = dashboardReply("project-a");
    const summaryB = deferred<FetchReply>();
    const agentsB = deferred<FetchReply>();
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success({ items: [{ id: "project-a", name: "project-a" }, { id: "project-b", name: "project-b" }], next_cursor: null });
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/summary")) return success(projectA.summary);
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/agents")) return success(projectA.agents);
      if (request.pathname.includes("project-a")) return success({ has_more: false, items: [{ actor: null, created_at: "2026-08-31T00:00:00.000Z", event_type: "agent.synced", id: "event-a", outcome: "success", sequence: 12 }] });
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/summary")) return summaryB.promise;
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/agents")) return agentsB.promise;
      return success({ has_more: false, items: [] });
    });

    await harness.settle();
    expect(harness.node("summary-project").textContent).toBe("project-a");
    harness.node("detail-drawer").hidden = false;
    harness.node("project-selector").value = "project-b";
    harness.node("project-selector").dispatch("change");

    expect(harness.node("summary-project").textContent).toBe("—");
    expect(allText(harness.node("data-view"))).toContain("Loading project…");
    expect(harness.node("detail-drawer").hidden).toBe(true);
    expect(harness.node("connection-status").textContent).toBe("Connecting…");
  });

  it("shows connecting immediately for tab and filter context refreshes", async () => {
    const base = dashboardReply("project-a");
    const messageLoad = deferred<FetchReply>();
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return success(base.summary);
      if (request.pathname.endsWith("/agents")) return success(base.agents);
      if (request.pathname.endsWith("/messages")) return messageLoad.promise;
      return success(base.events);
    });

    await harness.settle();
    harness.tab("messages").dispatch("click");
    expect(harness.node("connection-status").textContent).toBe("Connecting…");
    messageLoad.resolve(success(base.messages));
    await harness.settle();
    expect(harness.node("connection-status").textContent).toBe("Connected");
    const filter = harness.node("filters").children[0]?.children[0];
    filter?.dispatch("change");
    expect(harness.node("connection-status").textContent).toBe("Connecting…");
  });

  it("leaves the current context timer and in-flight poll owned by B when stale A completes", async () => {
    const projectA = dashboardReply("project-a");
    const projectB = dashboardReply("project-b");
    const pollA = deferred<FetchReply>();
    const pollB = deferred<FetchReply>();
    let aEvents = 0;
    let bEvents = 0;
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success({ items: [{ id: "project-a", name: "project-a" }, { id: "project-b", name: "project-b" }], next_cursor: null });
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/summary")) return success(projectA.summary);
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/agents")) return success(projectA.agents);
      if (request.pathname.includes("project-a") && request.pathname.endsWith("/events")) {
        aEvents += 1;
        return aEvents === 1 ? success(projectA.events) : pollA.promise;
      }
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/summary")) return success(projectB.summary);
      if (request.pathname.includes("project-b") && request.pathname.endsWith("/agents")) return success(projectB.agents);
      bEvents += 1;
      return bEvents === 1 ? success(projectB.events) : pollB.promise;
    });

    await harness.settle();
    await harness.runTimer();
    harness.node("project-selector").value = "project-b";
    harness.node("project-selector").dispatch("change");
    await harness.settle();
    expect(harness.timers).toHaveLength(1);
    await harness.runTimer();
    expect(harness.timers).toHaveLength(0);
    pollA.resolve(success({ has_more: false, items: [] }));
    await harness.settle();
    expect(harness.timers).toHaveLength(0);
    pollB.resolve(success({ has_more: false, items: [] }));
    await harness.settle();
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delay).toBe(1_000);
  });

  it("slows hidden polling and defers incoming activity while the operator is scrolled away", async () => {
    const base = dashboardReply("project-a");
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return success(base.summary);
      if (request.pathname.endsWith("/agents")) return success(base.agents);
      if (request.searchParams.has("after")) return success({ has_more: false, items: [{ actor: null, created_at: "2026-08-31T00:00:01.000Z", event_type: "agent.synced", id: "event-13", outcome: "success", sequence: 13 }] });
      return success({ has_more: false, items: [{ actor: null, created_at: "2026-08-31T00:00:00.000Z", event_type: "agent.synced", id: "event-12", outcome: "success", sequence: 12 }] });
    });

    await harness.settle();
    harness.window.scrollY = 120;
    await harness.runTimer();
    expect(harness.node("new-activity").hidden).toBe(false);
    harness.dispatchVisibility(true);
    expect(harness.timers[0]?.delay).toBe(15_000);
  });

  it("keeps controller interactions dependency-free for scroll, login, drawer, and logout", async () => {
    const base = dashboardReply("project-a");
    const message = { acknowledged_at: null, created_at: "2026-08-31T00:00:00.000Z", id: "message-a", recipient: { name: "recipient" }, sender: { name: "sender" }, sequence: 12 };
    const harness = createControllerHarness(async (url) => {
      const request = new URL(url, "http://localhost");
      if (request.pathname === "/api/admin/projects") return success(base.projects);
      if (request.pathname.endsWith("/summary")) return success(base.summary);
      if (request.pathname.endsWith("/agents")) return success(base.agents);
      if (request.pathname.endsWith("/messages/message-a")) return success(message);
      if (request.pathname.endsWith("/messages")) return success({ has_more: false, items: [message] });
      if (request.searchParams.has("after")) return success({ has_more: false, items: [{ actor: null, created_at: "2026-08-31T00:00:01.000Z", event_type: "agent.synced", id: "event-13", outcome: "success", sequence: 13 }] });
      return success({ has_more: false, items: [{ actor: null, created_at: "2026-08-31T00:00:00.000Z", event_type: "agent.synced", id: "event-12", outcome: "success", sequence: 12 }] });
    });

    await harness.settle();
    harness.tab("messages").dispatch("click");
    await harness.settle();
    const metadataButton = harness.node("data-view").children[0]?.children[1]?.children[0]?.children[2]?.children[0];
    metadataButton?.dispatch("click");
    await harness.settle();
    expect(harness.node("drawer-text").textContent).toContain('"id": "message-a"');
    expect(harness.node("drawer-text").textContent).not.toContain("full private message");
    harness.node("logout-button").dispatch("click");
    await harness.settle();
    expect(harness.calls.at(-1)?.options?.method).toBe("DELETE");

    const loginHarness = createControllerHarness(async () => success({}, 204), true);
    loginHarness.node("login-token").value = "token";
    loginHarness.node("login-form").dispatch("submit");
    await loginHarness.settle();
    expect(loginHarness.calls[0]).toEqual(expect.objectContaining({ options: expect.objectContaining({ body: '{"token":"token"}', headers: { "content-type": "application/json" }, method: "POST" }) }));
    expect(loginHarness.reloaded()).toBe(true);
  });
});

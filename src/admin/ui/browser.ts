export interface PollState {
  visible: boolean;
  failures: number;
}

export function nextPollDelay(state: PollState): number {
  if (!state.visible) return 15_000;
  if (state.failures === 0) return 1_000;
  return Math.min(15_000, 1_000 * 2 ** (state.failures - 1));
}

export function newestSequence(current: number, rows: Array<{ sequence: number }>): number {
  return rows.reduce((newest, row) => Math.max(newest, row.sequence), current);
}

export const ADMIN_BROWSER_SOURCE = String.raw`
(() => {
  const byId = (id) => document.getElementById(id);
  const state = {
    agents: [], failures: 0, filterSignature: "", generation: 0, pendingActivity: [], pollTimer: null, polling: false,
    projectId: null, rows: { activity: [], messages: [], agents: [] },
    ready: false, sequences: { activity: 0, messages: 0 }, tab: "activity"
  };
  const app = byId("app");
  const loginForm = byId("login-form");
  const setText = (id, value) => { const node = byId(id); if (node) node.textContent = String(value); };
  const setStatus = (connected, detail, context) => {
    if (context && !current(context)) return;
    const node = byId("connection-status");
    if (node) { node.dataset.state = connected ? "connected" : "disconnected"; node.textContent = detail || (connected ? "Connected" : "Disconnected"); }
  };
  const request = async (path, options) => {
    const response = await fetch(path, { credentials: "same-origin", ...options });
    if (!response.ok) throw new Error("Request failed");
    return response.status === 204 ? null : response.json();
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const option = (value, label) => { const node = document.createElement("option"); node.value = value; node.textContent = label; return node; };
  const select = (name, label, choices) => {
    const wrapper = document.createElement("label"); wrapper.className = "field"; wrapper.textContent = label;
    const node = document.createElement("select"); node.name = name; node.append(option("", "All"));
    choices.forEach((choice) => node.append(option(choice.value, choice.label))); wrapper.append(node); return wrapper;
  };
  const badge = (value, kind) => { const node = document.createElement("span"); node.className = "badge " + kind; node.textContent = value; return node; };
  const cell = (value) => { const node = document.createElement("td"); if (typeof value === "string" || typeof value === "number") node.textContent = String(value); else node.append(value); return node; };
  const formatTime = (value) => new Date(value).toLocaleString();
  const encodeSequenceCursor = (sequence) => btoa(JSON.stringify({ kind: "sequence", sequence })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const filterQuery = () => {
    const params = new URLSearchParams(); const filters = byId("filters");
    if (filters) filters.querySelectorAll("select").forEach((field) => { if (field.value) params.set(field.name, field.value); });
    return params.toString();
  };
  const requestQuery = (filters, after) => {
    const params = new URLSearchParams(filters);
    if (after !== undefined) params.set("after", encodeSequenceCursor(after));
    const text = params.toString(); return text ? "?" + text : "";
  };
  const snapshot = () => ({ filters: state.filterSignature, generation: state.generation, projectId: state.projectId, tab: state.tab });
  const current = (context) => context.filters === state.filterSignature && context.generation === state.generation && context.projectId === state.projectId && context.tab === state.tab;
  const projectUrl = (projectId) => "/api/admin/projects/" + encodeURIComponent(projectId);
  const bumpGeneration = () => { state.generation += 1; return snapshot(); };
  const renderSummary = (summary) => {
    setText("summary-project", summary.project.name);
    setText("summary-agents", summary.agents.online + " / " + summary.agents.total);
    setText("summary-messages", summary.messages.unacknowledged + " / " + summary.messages.total);
    setText("summary-failures", summary.failures_last_24h);
  };
  const renderFilters = () => {
    const filters = byId("filters"); clear(filters);
    if (state.tab === "agents") { filters.hidden = true; return; }
    filters.hidden = false;
    filters.append(select("agent_id", "Agent", state.agents.map((agent) => ({ value: agent.id, label: agent.name }))));
    if (state.tab === "activity") {
      filters.append(select("event_type", "Event type", ["agent.registered", "agent.registration_failed", "agent.synced", "message.sent", "message.send_failed", "message.acknowledged", "mcp.request_failed"].map((value) => ({ value, label: value }))));
      filters.append(select("outcome", "Outcome", [{ value: "success", label: "Success" }, { value: "failure", label: "Failure" }]));
    }
    if (state.tab === "messages") filters.append(select("acknowledged", "Acknowledged", [{ value: "true", label: "Acknowledged" }, { value: "false", label: "Unacknowledged" }]));
    const selected = new URLSearchParams(state.filterSignature);
    filters.querySelectorAll("select").forEach((field) => { field.value = selected.get(field.name) || ""; });
    filters.querySelectorAll("select").forEach((field) => field.addEventListener("change", () => {
      state.filterSignature = filterQuery(); resetContext(false); const context = bumpGeneration();
      loadProject(context).then(loaded => { if (loaded && current(context)) { state.failures = 0; setStatus(true, "Connected", context); } }).catch(() => disconnected(context));
    }));
  };
  const header = (labels) => {
    const row = document.createElement("tr");
    labels.forEach((label) => { const item = document.createElement("th"); item.scope = "col"; item.textContent = label; row.append(item); });
    return row;
  };
  const renderRows = () => {
    const dataView = byId("data-view"); clear(dataView); const rows = state.rows[state.tab];
    if (rows.length === 0) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = state.ready ? "No matching records" : "Loading project…"; dataView.append(empty); return; }
    const table = document.createElement("table"); const head = document.createElement("thead"); const body = document.createElement("tbody");
    if (state.tab === "activity") {
      head.append(header(["Event", "Outcome", "Actor", "When"]));
      rows.forEach((item) => { const row = document.createElement("tr"); row.append(cell(item.event_type), cell(badge(item.outcome, item.outcome)), cell(item.actor ? item.actor.name : "System"), cell(formatTime(item.created_at))); body.append(row); });
    }
    if (state.tab === "messages") {
      head.append(header(["From", "To", "Preview", "Acknowledgement", "When"]));
      rows.forEach((item) => {
        const row = document.createElement("tr"); const open = document.createElement("button");
        open.type = "button"; open.className = "row-button"; open.textContent = item.preview; open.addEventListener("click", () => openMessage(item.id));
        row.append(cell(item.sender.name), cell(item.recipient.name), cell(open), cell(badge(item.acknowledged_at ? "Acknowledged" : "Unacknowledged", item.acknowledged_at ? "success" : "failure")), cell(formatTime(item.created_at))); body.append(row);
      });
    }
    if (state.tab === "agents") {
      head.append(header(["Agent", "Client", "Presence", "Last seen"]));
      rows.forEach((item) => { const row = document.createElement("tr"); row.append(cell(item.name), cell(item.client), cell(badge(item.status, item.status)), cell(formatTime(item.last_seen_at))); body.append(row); });
    }
    table.append(head, body); dataView.append(table);
  };
  const applyAcknowledgements = (events) => {
    events.filter((event) => event.event_type === "message.acknowledged" && event.message_id).forEach((event) => {
      state.rows.messages.forEach((message) => { if (message.id === event.message_id) message.acknowledged_at = event.created_at; });
    });
    if (state.tab === "messages") renderRows();
  };
  const disconnected = (context) => {
    if (!current(context)) return;
    state.failures += 1; setStatus(false, "Disconnected", context);
  };
  const resetContext = (projectChanged) => {
    state.ready = false; state.pendingActivity = []; byId("new-activity").hidden = true;
    state.sequences = { activity: 0, messages: 0 };
    if (projectChanged) {
      state.agents = []; state.rows = { activity: [], messages: [], agents: [] };
      setText("summary-project", "—"); setText("summary-agents", "—"); setText("summary-messages", "—"); setText("summary-failures", "—");
      clear(byId("filters"));
    } else state.rows[state.tab] = [];
    setText("drawer-title", "Message details"); setText("drawer-text", ""); byId("detail-drawer").hidden = true;
    renderRows();
  };
  const updateRows = (tab, rows, replace) => {
    if (tab === "activity" && !replace && window.scrollY > 80) {
      state.pendingActivity = rows.concat(state.pendingActivity); byId("new-activity").hidden = false; return;
    }
    state.rows[tab] = replace ? rows : rows.concat(state.rows[tab]);
    if (tab === state.tab) renderRows();
  };
  const openMessage = async (messageId) => {
    const context = snapshot();
    try {
      const item = await request(projectUrl(context.projectId) + "/messages/" + encodeURIComponent(messageId));
      if (!current(context)) return;
      setText("drawer-title", "Message details"); setText("drawer-text", item.text);
      byId("detail-drawer").hidden = false; byId("drawer-close").focus();
    } catch { disconnected(context); }
  };
  const endpointForTab = (tab) => tab === "activity" ? "events" : tab;
  const loadProject = async (context) => {
    if (context.projectId === null) return false;
    const base = projectUrl(context.projectId);
    const [summary, agents, active] = await Promise.all([
      request(base + "/summary"),
      request(base + "/agents"),
      request(base + "/" + endpointForTab(context.tab) + (context.filters ? "?" + context.filters : "")),
    ]);
    if (!current(context)) return false;
    renderSummary(summary); state.agents = agents.items; state.rows = { activity: [], messages: [], agents: [] };
    state.rows[context.tab] = active.items;
    state.sequences = {
      activity: context.tab === "activity" ? active.items.reduce((latest, item) => Math.max(latest, item.sequence), 0) : 0,
      messages: context.tab === "messages" ? active.items.reduce((latest, item) => Math.max(latest, item.sequence), 0) : 0,
    };
    state.pendingActivity = []; byId("new-activity").hidden = true; state.ready = true;
    renderFilters(); renderRows(); return true;
  };
  const loadProjects = async () => {
    const context = snapshot();
    const projects = await request("/api/admin/projects");
    if (!current(context)) return false;
    const selector = byId("project-selector"); clear(selector);
    projects.items.forEach((project) => selector.append(option(project.id, project.name)));
    if (!state.projectId) state.projectId = projects.items[0] ? projects.items[0].id : null;
    if (state.projectId === null) return false;
    selector.value = state.projectId;
    const projectContext = bumpGeneration();
    try { return await loadProject(projectContext); }
    catch {
      disconnected(projectContext);
      return false;
    }
  };
  const pollIncremental = async (tab, context, filters) => {
    if (context.projectId === null) return;
    let after = state.sequences[tab]; let newest = after; let hasMore = true; const received = [];
    while (hasMore) {
      const result = await request(projectUrl(context.projectId) + "/" + endpointForTab(tab) + requestQuery(filters, after));
      if (!current(context)) return;
      received.push(...result.items); newest = result.items.reduce((latest, item) => Math.max(latest, item.sequence), newest);
      hasMore = result.has_more === true; after = newest;
    }
    if (!current(context)) return;
    if (received.length > 0) {
      if (tab === "activity") applyAcknowledgements(received);
      updateRows(tab, received, false);
    }
    state.sequences[tab] = newest;
  };
  const schedulePoll = (delay) => {
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    state.pollTimer = window.setTimeout(poll, delay);
  };
  const poll = async () => {
    if (state.polling) return;
    state.polling = true;
    let context = snapshot();
    try {
      if (!state.ready) {
        const loaded = state.projectId === null ? await loadProjects() : await loadProject(context);
        if (!loaded) return;
        context = snapshot();
      } else {
        context = snapshot();
        const activeFilters = filterQuery();
        if (state.tab === "messages") await Promise.all([pollIncremental("activity", context, ""), pollIncremental("messages", context, activeFilters)]);
        else if (state.tab === "activity") await pollIncremental("activity", context, activeFilters);
      }
      if (!current(context) || !state.ready) return;
      state.failures = 0; setStatus(true, "Connected", context);
    } catch { disconnected(context); }
    finally {
      state.polling = false;
      schedulePoll(document.hidden ? 15_000 : (state.failures === 0 ? 1_000 : Math.min(15_000, 1_000 * 2 ** (state.failures - 1))));
    }
  };
  const boot = async () => {
    const context = snapshot();
    try {
      const loaded = await loadProjects();
      const completed = snapshot();
      if (!loaded || !current(completed)) return;
      state.failures = 0; setStatus(true, "Connected", completed);
    } catch { disconnected(context); }
    finally { schedulePoll(1_000); }
  };
  if (loginForm) loginForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const error = byId("login-error"); error.textContent = "";
    try {
      const response = await fetch("/admin/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: byId("login-token").value }) });
      if (!response.ok) throw new Error("Login failed"); window.location.reload();
    } catch { error.textContent = "Sign in failed. Check the token and try again."; }
  });
  if (app) {
    byId("project-selector").addEventListener("change", (event) => {
      state.projectId = event.currentTarget.value; state.filterSignature = ""; resetContext(true);
      const context = bumpGeneration();
      loadProject(context).then(loaded => { if (loaded && current(context)) { state.failures = 0; setStatus(true, "Connected", context); } }).catch(() => disconnected(context));
    });
    document.querySelectorAll("[role=tab]").forEach((tab) => tab.addEventListener("click", () => {
      state.tab = tab.dataset.tab; state.filterSignature = ""; resetContext(false); const context = bumpGeneration();
      document.querySelectorAll("[role=tab]").forEach((item) => item.setAttribute("aria-selected", String(item === tab)));
      renderFilters();
      loadProject(context).then(loaded => { if (loaded && current(context)) { state.failures = 0; setStatus(true, "Connected", context); } }).catch(() => disconnected(context));
    }));
    byId("logout-button").addEventListener("click", async () => { await fetch("/admin/session", { method: "DELETE", credentials: "same-origin" }); window.location.reload(); });
    byId("drawer-close").addEventListener("click", () => { byId("detail-drawer").hidden = true; });
    byId("new-activity").addEventListener("click", () => {
      state.rows.activity = state.pendingActivity.concat(state.rows.activity); state.pendingActivity = [];
      byId("new-activity").hidden = true; renderRows(); window.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.addEventListener("visibilitychange", () => { schedulePoll(document.hidden ? 15_000 : 0); });
    boot();
  }
})();
`;

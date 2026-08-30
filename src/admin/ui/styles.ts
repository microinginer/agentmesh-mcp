export const ADMIN_STYLES = String.raw`
:root { color-scheme: light dark; --canvas: #f8fafc; --surface: #ffffff; --ink: #111827; --muted: #64748b; --border: #dbe2ea; --accent: #2563eb; --accent-soft: #dbeafe; --success: #15803d; --warning: #b45309; --danger: #b91c1c; --focus: #1d4ed8; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.45; }
button, input, select { font: inherit; }
button, select, input { min-height: 36px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); }
button { padding: 0 12px; cursor: pointer; font-weight: 600; }
button:hover { background: var(--accent-soft); border-color: var(--accent); }
button:disabled { cursor: not-allowed; opacity: .55; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.shell { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 48px; }
.topbar, .context-row, .tabs, .filters, .status, .summary-grid, .drawer-head { display: flex; align-items: center; gap: 12px; }
.topbar { justify-content: space-between; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
h1 { margin: 0; font-size: 28px; letter-spacing: -.025em; line-height: 1.2; }
h2 { margin: 0; font-size: 20px; letter-spacing: -.015em; }
.context-row { justify-content: space-between; padding: 16px 0; }
.field { display: grid; gap: 4px; color: var(--muted); font-size: 12px; font-weight: 650; }
.field select, .field input { min-width: 180px; padding: 0 10px; font-weight: 400; }
.status { color: var(--muted); font-size: 12px; font-weight: 650; }
.status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--success); }
.status[data-state="disconnected"]::before { background: var(--danger); }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 4px 0 24px; }
.metric { min-height: 104px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.metric-label { color: var(--muted); font-size: 12px; font-weight: 650; }
.metric-value { display: block; margin-top: 8px; font-size: 28px; font-weight: 700; letter-spacing: -.025em; }
.tabs { border-bottom: 1px solid var(--border); }
[role="tab"] { min-height: 44px; padding: 0 14px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); }
[role="tab"][aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
.filters { flex-wrap: wrap; padding: 16px 0; }
.filters[hidden], .new-activity[hidden], .drawer[hidden] { display: none; }
.filters .field select { min-width: 144px; }
.data-surface { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
table { width: 100%; border-collapse: collapse; min-width: 720px; }
th, td { padding: 12px 16px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: 12px; font-weight: 650; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--accent-soft); }
.row-button { width: 100%; min-height: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: inherit; font-weight: inherit; text-align: left; }
.row-button:hover { background: transparent; }
.badge { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 650; white-space: nowrap; }
.badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.badge.success::before, .badge.online::before { background: var(--success); }
.badge.failure::before, .badge.offline::before { background: var(--danger); }
.badge.idle::before { background: var(--warning); }
.new-activity { margin: 12px 0 0; color: var(--accent); }
.empty { padding: 32px 16px; color: var(--muted); text-align: center; }
.drawer { position: fixed; z-index: 10; top: 0; right: 0; width: min(480px, 100%); height: 100%; padding: 24px; overflow-y: auto; border-left: 1px solid var(--border); background: var(--surface); box-shadow: -12px 0 32px rgba(15, 23, 42, .12); }
.drawer-head { justify-content: space-between; }
.drawer-text { margin: 24px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.login { width: min(400px, calc(100% - 32px)); margin: 12vh auto; padding: 24px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.login form { display: grid; gap: 16px; margin-top: 24px; }
.login input { width: 100%; padding: 0 10px; }
.form-error { min-height: 20px; color: var(--danger); font-size: 12px; }
@media (max-width: 900px) { .context-row { align-items: flex-end; } .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .shell { width: min(100% - 24px, 1120px); padding-top: 16px; } .topbar, .context-row { align-items: flex-start; flex-direction: column; } .summary-grid { grid-template-columns: 1fr; } .field select, .field input { width: 100%; min-width: 0; } .drawer { padding: 20px; } }
@media (prefers-color-scheme: dark) { :root { --canvas: #111827; --surface: #18212f; --ink: #f8fafc; --muted: #a7b5c8; --border: #334155; --accent-soft: #1e3a5f; --focus: #60a5fa; } .drawer { box-shadow: -12px 0 32px rgba(0, 0, 0, .35); } }
`;

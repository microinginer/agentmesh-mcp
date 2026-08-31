export interface SafeLogEvent {
  event: "activity.persist_failed" | "mcp.request_failed" | "http.request_failed";
  request_id?: string;
  user_id?: string;
  project_id?: string;
  connection_id?: string;
  error_code?: "INTERNAL_ERROR";
}

export interface SafeLogger {
  write(event: SafeLogEvent): void;
}

const SAFE_EVENTS = new Set<SafeLogEvent["event"]>([
  "activity.persist_failed",
  "mcp.request_failed",
  "http.request_failed",
]);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SECRET_MARKER = /(?:am_(?:proj|agent)_|authorization|bearer|cookie|oauth|csrf|secret|token)/i;

function safeUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID_V4_PATTERN.test(value) ? value : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) && !SECRET_MARKER.test(value)
    ? value
    : undefined;
}

function sanitizeEvent(value: unknown): SafeLogEvent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.event !== "string" || !SAFE_EVENTS.has(candidate.event as SafeLogEvent["event"])) return null;
  const safe: SafeLogEvent = { event: candidate.event as SafeLogEvent["event"] };
  const requestId = safeRequestId(candidate.request_id);
  const userId = safeUuid(candidate.user_id);
  const projectId = safeUuid(candidate.project_id);
  const connectionId = safeUuid(candidate.connection_id);
  if (requestId !== undefined) safe.request_id = requestId;
  if (userId !== undefined) safe.user_id = userId;
  if (projectId !== undefined) safe.project_id = projectId;
  if (connectionId !== undefined) safe.connection_id = connectionId;
  if (candidate.error_code === "INTERNAL_ERROR") safe.error_code = candidate.error_code;
  return safe;
}

export function createSafeLogger(): SafeLogger {
  return {
    write(event): void {
      const safe = sanitizeEvent(event);
      if (safe === null) return;
      try {
        process.stderr.write(`${JSON.stringify(safe)}\n`);
      } catch {}
    },
  };
}

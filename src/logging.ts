export interface SafeLogEvent {
  event: "activity.persist_failed" | "mcp.request_failed" | "http.request_failed";
  request_id?: string;
  project_id?: string;
  error_code?: "INTERNAL_ERROR";
}

export interface SafeLogger {
  write(event: SafeLogEvent): void;
}

export function createSafeLogger(): SafeLogger {
  return {
    write(event): void {
      const safe: SafeLogEvent = { event: event.event };
      if (typeof event.request_id === "string") {
        safe.request_id = event.request_id;
      }
      if (typeof event.project_id === "string") {
        safe.project_id = event.project_id;
      }
      if (event.error_code === "INTERNAL_ERROR") {
        safe.error_code = event.error_code;
      }
      try {
        process.stderr.write(`${JSON.stringify(safe)}\n`);
      } catch {}
    },
  };
}

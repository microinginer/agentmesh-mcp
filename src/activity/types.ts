export const activityEventTypes = [
  "agent.registered",
  "agent.registration_failed",
  "agent.synced",
  "message.sent",
  "message.send_failed",
  "message.acknowledged",
  "mcp.request_failed",
] as const;

export type ActivityEventType = (typeof activityEventTypes)[number];
export type ActivityOutcome = "success" | "failure";

export interface ActivityMetadata {
  message_bytes?: number;
  delivered_count?: number;
  acknowledged_count?: number;
  poll_limit?: number;
  deduplicated?: boolean;
}

export interface OperationContext {
  requestId: string;
}

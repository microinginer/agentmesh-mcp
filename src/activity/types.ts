export const activityEventTypes = [
  "agent.registered",
  "agent.registration_failed",
  "agent.synced",
  "message.sent",
  "message.send_failed",
  "message.acknowledged",
  "blackboard.fact_set",
  "blackboard.fact_deleted",
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
  blackboard_namespace?: string;
  blackboard_key?: string;
  blackboard_version?: number;
}

export interface OperationContext {
  requestId: string;
}

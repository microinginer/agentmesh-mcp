export type AgentMeshErrorCode =
  | "AGENT_AUTH_INVALID"
  | "PROJECT_AUTH_INVALID"
  | "REGISTRATION_CONFLICT"
  | "TARGET_AGENT_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "INTERNAL_ERROR";

export class AgentMeshError extends Error {
  readonly code: AgentMeshErrorCode;

  constructor(code: AgentMeshErrorCode, message: string) {
    super(message);
    this.name = "AgentMeshError";
    this.code = code;
  }
}

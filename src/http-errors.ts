import type { FastifyReply, FastifyRequest } from "fastify";

export type WebHttpErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_UNAVAILABLE"
  | "CSRF_FORBIDDEN"
  | "OPERATOR_FORBIDDEN"
  | "INVALID_REQUEST"
  | "USER_NOT_FOUND"
  | "USER_BLOCKED"
  | "USER_STATE_CONFLICT"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_LIMIT_REACHED"
  | "PROJECT_STATE_CONFLICT"
  | "PROJECT_CONFIRMATION_MISMATCH"
  | "CONNECTION_NOT_FOUND"
  | "CONNECTION_STATE_CONFLICT"
  | "BLOCKER_NOT_FOUND"
  | "BLOCKER_STATE_CONFLICT"
  | "RECENT_AUTH_REQUIRED"
  | "CONTROL_UNAVAILABLE";

const messages: Record<WebHttpErrorCode, string> = {
  AUTH_REQUIRED: "Authentication is required",
  AUTH_UNAVAILABLE: "Authentication is temporarily unavailable",
  CSRF_FORBIDDEN: "Request validation failed",
  OPERATOR_FORBIDDEN: "Operator access is required",
  INVALID_REQUEST: "Request validation failed",
  USER_NOT_FOUND: "User was not found",
  USER_BLOCKED: "User is blocked",
  USER_STATE_CONFLICT: "User lifecycle state conflict",
  PROJECT_NOT_FOUND: "Project was not found",
  PROJECT_LIMIT_REACHED: "Active project limit reached",
  PROJECT_STATE_CONFLICT: "Project lifecycle state conflict",
  PROJECT_CONFIRMATION_MISMATCH: "Project name confirmation did not match",
  CONNECTION_NOT_FOUND: "Connection was not found",
  CONNECTION_STATE_CONFLICT: "Connection lifecycle state conflict",
  BLOCKER_NOT_FOUND: "Blocker was not found",
  BLOCKER_STATE_CONFLICT: "Only an unresolved blocker from an offline agent can be resolved",
  RECENT_AUTH_REQUIRED: "Recent GitHub authentication is required",
  CONTROL_UNAVAILABLE: "Control plane is temporarily unavailable",
};

export function sendWebHttpError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 400 | 401 | 403 | 404 | 409 | 413 | 503,
  code: WebHttpErrorCode,
) {
  return reply.code(statusCode).send({
    error: {
      code,
      message: messages[code],
      request_id: request.id,
    },
  });
}

export function sendInvalidPayloadError(error: Error, request: FastifyRequest, reply: FastifyReply) {
  const status = (error as Error & { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413 : 400;
  return sendWebHttpError(request, reply, status, "INVALID_REQUEST");
}

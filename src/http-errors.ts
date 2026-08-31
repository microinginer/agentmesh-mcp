import type { FastifyReply, FastifyRequest } from "fastify";

export type WebHttpErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_UNAVAILABLE"
  | "CSRF_FORBIDDEN"
  | "OPERATOR_FORBIDDEN"
  | "INVALID_REQUEST"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_LIMIT_REACHED"
  | "PROJECT_STATE_CONFLICT"
  | "PROJECT_CONFIRMATION_MISMATCH"
  | "RECENT_AUTH_REQUIRED"
  | "CONTROL_UNAVAILABLE";

const messages: Record<WebHttpErrorCode, string> = {
  AUTH_REQUIRED: "Authentication is required",
  AUTH_UNAVAILABLE: "Authentication is temporarily unavailable",
  CSRF_FORBIDDEN: "Request validation failed",
  OPERATOR_FORBIDDEN: "Operator access is required",
  INVALID_REQUEST: "Request validation failed",
  PROJECT_NOT_FOUND: "Project was not found",
  PROJECT_LIMIT_REACHED: "Active project limit reached",
  PROJECT_STATE_CONFLICT: "Project lifecycle state conflict",
  PROJECT_CONFIRMATION_MISMATCH: "Project name confirmation did not match",
  RECENT_AUTH_REQUIRED: "Recent GitHub authentication is required",
  CONTROL_UNAVAILABLE: "Control plane is temporarily unavailable",
};

export function sendWebHttpError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 400 | 401 | 403 | 404 | 409 | 503,
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

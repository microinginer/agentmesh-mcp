import type { FastifyReply, FastifyRequest } from "fastify";

export type WebHttpErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_UNAVAILABLE"
  | "CSRF_FORBIDDEN"
  | "OPERATOR_FORBIDDEN";

const messages: Record<WebHttpErrorCode, string> = {
  AUTH_REQUIRED: "Authentication is required",
  AUTH_UNAVAILABLE: "Authentication is temporarily unavailable",
  CSRF_FORBIDDEN: "Request validation failed",
  OPERATOR_FORBIDDEN: "Operator access is required",
};

export function sendWebHttpError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 401 | 403 | 503,
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

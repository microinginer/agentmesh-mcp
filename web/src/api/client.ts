import type { z } from "zod";

import { apiErrorSchema, sessionResponseSchema, type SessionResponse } from "./schemas";

type Fetcher = typeof fetch;

export interface MutationOptions {
  method: "POST" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function ensureApiPath(path: string): void {
  if (!path.startsWith("/api/v1/") || path.startsWith("//") || path.includes("\\")) {
    throw new ApiError(0, "INVALID_PATH", "Invalid API path");
  }
}

async function safeJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class ApiClient {
  readonly #fetcher: Fetcher;
  #csrfToken: string | null = null;

  constructor(fetcher: Fetcher = globalThis.fetch.bind(globalThis)) {
    this.#fetcher = fetcher;
  }

  async loadSession(): Promise<SessionResponse> {
    const response = await this.#request("/api/v1/session", { method: "GET" });
    const parsed = sessionResponseSchema.safeParse(response);
    if (!parsed.success) throw new ApiError(502, "INVALID_RESPONSE", "AgentMesh returned an invalid response");
    this.#csrfToken = parsed.data.csrf_token;
    return parsed.data;
  }

  clearSession(): void {
    this.#csrfToken = null;
  }

  async query<T = unknown>(path: string, schema?: z.ZodType<T>): Promise<T> {
    const value = await this.#request(path, { method: "GET" });
    if (schema === undefined) return value as T;
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiError(502, "INVALID_RESPONSE", "AgentMesh returned an invalid response");
    return parsed.data;
  }

  async mutate<T = unknown>(path: string, options: MutationOptions, schema?: z.ZodType<T>): Promise<T | undefined> {
    if (this.#csrfToken === null) throw new ApiError(401, "AUTH_REQUIRED", "Authentication is required");
    const headers: Record<string, string> = { "X-CSRF-Token": this.#csrfToken };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
    const value = await this.#request(path, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (value === undefined || schema === undefined) return value as T | undefined;
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiError(502, "INVALID_RESPONSE", "AgentMesh returned an invalid response");
    return parsed.data;
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    ensureApiPath(path);
    let response: Response;
    try {
      response = await this.#fetcher(path, { ...init, credentials: "same-origin" });
    } catch {
      throw new ApiError(0, "NETWORK_UNAVAILABLE", "AgentMesh is temporarily unavailable");
    }
    if (response.status === 204) return undefined;
    const value = await safeJson(response);
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(value);
      if (response.status === 401) this.#csrfToken = null;
      throw parsed.success
        ? new ApiError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.request_id)
        : new ApiError(response.status, "REQUEST_FAILED", "AgentMesh request failed");
    }
    if (value === null) throw new ApiError(502, "INVALID_RESPONSE", "AgentMesh returned an invalid response");
    return value;
  }
}

export const SAFE_HTTP_ERROR = "Smoke HTTP request failed";
export const SAFE_RESPONSE_ERROR = "Smoke response rejected";
export const SAFE_SECRET_ERROR = "Smoke secrecy check failed";

export const SMOKE_RESPONSE_LIMIT_BYTES = 256 * 1024;
export const SMOKE_REQUEST_TIMEOUT_MS = 5_000;

const credentialMarker = /am_(?:proj|agent)_[A-Za-z0-9_-]+|authorization/i;

function safeError(message: string): Error {
  return new Error(message);
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  void body?.cancel().catch(() => {
    // The only safe outcome is the caller's constant rejection.
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => {
    // The only safe outcome is the caller's constant rejection.
  });
}

export function assertSecretFree(value: unknown, secrets: readonly string[]): void {
  let rendered: string;
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    throw safeError(SAFE_SECRET_ERROR);
  }
  if (credentialMarker.test(rendered) || secrets.some((secret) => rendered.includes(secret))) {
    throw safeError(SAFE_SECRET_ERROR);
  }
}

export async function readBoundedText(
  response: Response,
  maxBytes = SMOKE_RESPONSE_LIMIT_BYTES,
  timeoutMs = SMOKE_REQUEST_TIMEOUT_MS,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw safeError(SAFE_RESPONSE_ERROR);
  }
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      cancelBody(response.body);
      throw safeError(SAFE_RESPONSE_ERROR);
    }
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(safeError(SAFE_RESPONSE_ERROR)), { once: true });
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        cancelReader(reader);
        throw safeError(SAFE_RESPONSE_ERROR);
      }
      chunks.push(value);
    }
  } catch {
    cancelReader(reader);
    throw safeError(SAFE_RESPONSE_ERROR);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function readBoundedJson(
  response: Response,
  maxBytes = SMOKE_RESPONSE_LIMIT_BYTES,
  timeoutMs = SMOKE_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const body = await readBoundedText(response, maxBytes, timeoutMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw safeError(SAFE_RESPONSE_ERROR);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw safeError(SAFE_RESPONSE_ERROR);
  }
  return parsed as Record<string, unknown>;
}

export async function readSecretFreeJson(
  response: Response,
  secrets: readonly string[],
): Promise<Record<string, unknown>> {
  const payload = await readBoundedJson(response);
  assertSecretFree(payload, secrets);
  return payload;
}

export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs = SMOKE_REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw safeError(SAFE_HTTP_ERROR);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch {
    throw safeError(SAFE_HTTP_ERROR);
  } finally {
    clearTimeout(timeout);
  }
}

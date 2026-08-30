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
  if (body === null) return;
  try {
    void body.cancel().catch(() => {});
  } catch {
    // The only safe outcome is the caller's constant rejection.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // The only safe outcome is the caller's constant rejection.
  }
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

function securityNormalizeAsciiEscapes(value: string): string {
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    normalized.push(value[index] ?? "");
    while (normalized.length >= 6) {
      const escapeStart = normalized.length - 6;
      if (normalized[escapeStart] !== "\\" || normalized[escapeStart + 1]?.toLowerCase() !== "u") break;
      const hex = normalized.slice(escapeStart + 2).join("");
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      const codeUnit = Number.parseInt(hex, 16);
      if (codeUnit > 0x7f) break;

      // Each collapse replaces six code units with one, so recursive escapes terminate
      // without growing the already bounded response body.
      normalized.length = escapeStart;
      normalized.push(String.fromCharCode(codeUnit));
    }
  }
  return normalized.join("");
}

function assertSecurityNormalizedSecretFree(value: string, secrets: readonly string[]): void {
  let normalized: string;
  try {
    normalized = securityNormalizeAsciiEscapes(value);
  } catch {
    throw safeError(SAFE_SECRET_ERROR);
  }
  assertSecretFree(normalized, secrets);
}

function readScope(timeoutOrSignal: number | AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (typeof timeoutOrSignal !== "number") {
    return { signal: timeoutOrSignal, dispose: () => {} };
  }
  if (!Number.isSafeInteger(timeoutOrSignal) || timeoutOrSignal < 1) {
    throw safeError(SAFE_RESPONSE_ERROR);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutOrSignal);
  return { signal: controller.signal, dispose: () => clearTimeout(timeout) };
}

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<StreamReadResult> {
  if (signal.aborted) return Promise.reject(safeError(SAFE_RESPONSE_ERROR));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(safeError(SAFE_RESPONSE_ERROR));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        reject(safeError(SAFE_RESPONSE_ERROR));
      },
    );
  });
}

export async function readBoundedText(
  response: Response,
  maxBytes = SMOKE_RESPONSE_LIMIT_BYTES,
  timeoutOrSignal: number | AbortSignal = SMOKE_REQUEST_TIMEOUT_MS,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw safeError(SAFE_RESPONSE_ERROR);
  }
  const scope = readScope(timeoutOrSignal);
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      cancelBody(response.body);
      scope.dispose();
      throw safeError(SAFE_RESPONSE_ERROR);
    }
  }
  if (response.body === null) {
    scope.dispose();
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, scope.signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw safeError(SAFE_RESPONSE_ERROR);
      }
      chunks.push(value);
    }
  } catch {
    cancelReader(reader);
    throw safeError(SAFE_RESPONSE_ERROR);
  } finally {
    scope.dispose();
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

function parseJson(body: string): Record<string, unknown> {
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

export async function readBoundedJson(
  response: Response,
  maxBytes = SMOKE_RESPONSE_LIMIT_BYTES,
  timeoutOrSignal: number | AbortSignal = SMOKE_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return parseJson(await readBoundedText(response, maxBytes, timeoutOrSignal));
}

export async function readSecretFreeJson(
  response: Response,
  secrets: readonly string[],
  timeoutOrSignal: number | AbortSignal = SMOKE_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const body = await readBoundedText(response, SMOKE_RESPONSE_LIMIT_BYTES, timeoutOrSignal);
  assertSecretFree(body, secrets);
  assertSecurityNormalizedSecretFree(body, secrets);
  const payload = parseJson(body);
  assertSecretFree(payload, secrets);
  return payload;
}

function isSafeFailure(error: unknown): boolean {
  return error instanceof Error && [SAFE_HTTP_ERROR, SAFE_RESPONSE_ERROR, SAFE_SECRET_ERROR].includes(error.message);
}

export async function withBoundedResponse<T>(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  timeoutMs = SMOKE_REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw safeError(SAFE_HTTP_ERROR);
  }
  const controller = new AbortController();
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    response = await fetchImpl(input, { ...init, signal: controller.signal });
    return await consume(response, controller.signal);
  } catch (error) {
    if (isSafeFailure(error)) throw error;
    throw safeError(SAFE_HTTP_ERROR);
  } finally {
    if (response?.body !== null && response?.bodyUsed === false) {
      cancelBody(response.body);
    }
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

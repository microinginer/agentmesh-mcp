import { describe, expect, it, vi } from "vitest";

import {
  SAFE_HTTP_ERROR,
  SAFE_RESPONSE_ERROR,
  SAFE_SECRET_ERROR,
  assertSecretFree,
  readBoundedJson,
  readSecretFreeJson,
  withBoundedResponse,
} from "../scripts/compose-smoke-helpers.js";

const plantedSecret = "planted-smoke-secret-value";

function errorText(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected operation to throw");
}

describe("Compose smoke helper boundaries", () => {
  it("rejects an activity payload whose raw metadata or unexpected property leaks a secret", async () => {
    const response = new Response(
      JSON.stringify({
        items: [{ id: "event-1", event_type: "message.sent", metadata: { token: plantedSecret }, unexpected: plantedSecret }],
      }),
    );

    await expect(readSecretFreeJson(response, [plantedSecret])).rejects.toThrow(SAFE_SECRET_ERROR);
  });

  it("scans duplicate-key raw JSON before parsing can overwrite the planted secret", async () => {
    const response = new Response(
      '{"items":[{"metadata":{"token":"planted-smoke-secret-value"},"metadata":{"safe":true}}]}',
    );

    await expect(readSecretFreeJson(response, [plantedSecret])).rejects.toThrow(SAFE_SECRET_ERROR);
  });

  it("scans parsed JSON after raw text so Unicode escapes cannot hide credential markers", async () => {
    const response = new Response('{"items":[{"\\u0061gent_token":"\\u0061m_proj_hidden"}]}');

    await expect(readSecretFreeJson(response, [])).rejects.toThrow(SAFE_SECRET_ERROR);
  });

  it("scans Unicode-normalized duplicate-key JSON before parsing can overwrite a credential marker", async () => {
    const response = new Response(String.raw`{"x":"\u0061m_proj_hidden","x":"safe"}`);

    await expect(readSecretFreeJson(response, [])).rejects.toThrow(SAFE_SECRET_ERROR);
  });

  it.each([
    ["credential m", String.raw`{"x":"a\u006d_proj_hidden","x":"safe"}`],
    ["credential underscore", String.raw`{"x":"am\u005fproj_hidden","x":"safe"}`],
    ["credential p", String.raw`{"x":"am_\u0070roj_hidden","x":"safe"}`],
    ["credential r", String.raw`{"x":"am_p\u0072oj_hidden","x":"safe"}`],
    ["credential o", String.raw`{"x":"am_pr\u006fj_hidden","x":"safe"}`],
    ["credential j", String.raw`{"x":"am_pro\u006a_hidden","x":"safe"}`],
    [
      "every project marker character",
      String.raw`{"x":"\u0061\u006d\u005f\u0070\u0072\u006f\u006a_hidden","x":"safe"}`,
    ],
    [
      "every agent marker character",
      String.raw`{"x":"\u0061\u006d\u005f\u0061\u0067\u0065\u006e\u0074_hidden","x":"safe"}`,
    ],
    [
      "every authorization marker character",
      String.raw`{"x":"\u0061\u0075\u0074\u0068\u006f\u0072\u0069\u007a\u0061\u0074\u0069\u006f\u006e","x":"safe"}`,
    ],
    ["JSON-escaped backslash", String.raw`{"x":"\\u0061m_proj_hidden","x":"safe"}`],
    ["recursively escaped backslash", String.raw`{"x":"\u005cu005cu0061m_proj_hidden","x":"safe"}`],
  ])("rejects a duplicate-key marker with an escaped %s", async (_description, body) => {
    await expect(readSecretFreeJson(new Response(body), [])).rejects.toThrow(SAFE_SECRET_ERROR);
  });

  it("keeps raw JSON and raw log secrecy failures constant and redacted", async () => {
    const rawJsonError = await readSecretFreeJson(
      new Response(JSON.stringify({ items: [{ metadata: { secret: plantedSecret } }] })),
      [plantedSecret],
    ).catch((error: unknown) => String(error));
    const rawLogError = errorText(() => assertSecretFree(`agentmesh log ${plantedSecret}`, [plantedSecret]));

    expect(rawJsonError).toBe(`Error: ${SAFE_SECRET_ERROR}`);
    expect(rawLogError).toBe(`Error: ${SAFE_SECRET_ERROR}`);
    expect(rawJsonError).not.toContain(plantedSecret);
    expect(rawLogError).not.toContain(plantedSecret);
  });

  it("cancels a chunked body immediately when it crosses the byte limit", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456789"));
      },
      cancel() {
        cancelled = true;
      },
    }));

    await expect(readBoundedJson(response, 8)).rejects.toThrow(SAFE_RESPONSE_ERROR);
    expect(cancelled).toBe(true);
  });

  it("cancels a hanging response body at the configured timeout", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }));

    await expect(readBoundedJson(response, 8, 10)).rejects.toThrow(SAFE_RESPONSE_ERROR);
    expect(cancelled).toBe(true);
  });

  it("aborts a hanging HTTP request at the configured timeout", async () => {
    let aborted = false;
    const hangingFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });

    await expect(
      withBoundedResponse("http://127.0.0.1/never", {}, async (response) => response.status, 10, hangingFetch),
    ).rejects.toThrow(SAFE_HTTP_ERROR);
    expect(aborted).toBe(true);
  });

  it("keeps the request timeout active from headers through a hanging response body", async () => {
    let cancelled = false;
    const headersThenHangingBody: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }));

    await expect(
      withBoundedResponse(
        "http://127.0.0.1/hanging-body",
        {},
        (response, signal) => readBoundedJson(response, 8, signal),
        10,
        headersThenHangingBody,
      ),
    ).rejects.toThrow(SAFE_RESPONSE_ERROR);
    expect(cancelled).toBe(true);
  });

  it("cancels a status-only response body before its lifecycle completes", async () => {
    let cancelled = false;
    const statusOnlyFetch: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }), { status: 200 });

    await expect(
      withBoundedResponse("http://127.0.0.1/status-only", {}, async (response) => response.status, 100, statusOnlyFetch),
    ).resolves.toBe(200);
    expect(cancelled).toBe(true);
  });

  it("does not wait for a status-only cancellation promise that never settles", async () => {
    let cancelled = false;
    const caller = new AbortController();
    const removeAbortListener = vi.spyOn(caller.signal, "removeEventListener");
    const neverSettlingCancelFetch: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    }));

    const lifecycle = withBoundedResponse(
      "http://127.0.0.1/never-settling-cancel",
      { signal: caller.signal },
      async (response) => response.status,
      1_000,
      neverSettlingCancelFetch,
    );
    await expect(Promise.race([lifecycle, new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error("too slow")), 25))])).resolves.toBe(200);
    expect(cancelled).toBe(true);
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("propagates a caller abort signal into the bounded request lifecycle", async () => {
    const caller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const pendingFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        receivedSignal = init?.signal ?? undefined;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

    const pending = withBoundedResponse("http://127.0.0.1/caller-abort", { signal: caller.signal }, async () => 204, 100, pendingFetch);
    caller.abort();

    await expect(pending).rejects.toThrow(SAFE_HTTP_ERROR);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

});

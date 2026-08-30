import { describe, expect, it } from "vitest";

import {
  SAFE_HTTP_ERROR,
  SAFE_RESPONSE_ERROR,
  SAFE_SECRET_ERROR,
  assertSecretFree,
  fetchWithTimeout,
  readBoundedJson,
  readSecretFreeJson,
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

    await expect(fetchWithTimeout("http://127.0.0.1/never", {}, 10, hangingFetch)).rejects.toThrow(SAFE_HTTP_ERROR);
    expect(aborted).toBe(true);
  });
});

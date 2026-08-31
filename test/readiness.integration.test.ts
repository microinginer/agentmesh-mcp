import { setTimeout as delay } from "node:timers/promises";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { buildHttpApp } from "../src/http.js";
import { createProjectService } from "../src/projects/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgres://agentmesh:agentmesh@127.0.0.1:55432/agentmesh_test";
const database = createDatabase(databaseUrl);
const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("bounded readiness test timed out")), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return predicate();
}

async function transactionPromisesSettled(
  results: ReadonlyArray<{ type: string; value?: unknown }>,
): Promise<boolean> {
  const operations = results.flatMap((result) => result.type === "return" && result.value instanceof Promise
    ? [result.value]
    : []);
  try {
    await bounded(Promise.allSettled(operations), 100);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  await migrateDatabase(database.db);
});

afterAll(async () => {
  await database.pool.end();
});

describe("database readiness lifecycle", () => {
  it("configures a real bounded pool acquisition timeout", () => {
    expect(database.pool.options.connectionTimeoutMillis).toBe(500);
  });

  it("single-flights saturated probes without leaving pool waiters", async () => {
    expect(database.pool.options.max).toBe(10);
    const held: PoolClient[] = [];
    const transaction = vi.spyOn(database.db, "transaction");
    const app = buildHttpApp({
      db: database.db,
      signingKey,
      projectService: createProjectService({ db: database.db }),
      host: "127.0.0.1",
      allowedHosts: ["127.0.0.1", "localhost"],
      admin: null,
      logger: { write: () => {} },
    });
    try {
      for (let index = 0; index < 10; index += 1) {
        held.push(await bounded(database.pool.connect(), 2_000));
      }
      const waitingBaseline = database.pool.waitingCount;
      expect(waitingBaseline).toBe(0);
      transaction.mockClear();

      const probes = Array.from({ length: 5 }, () => app.inject({ method: "GET", url: "/ready" }));
      expect(await waitFor(() => database.pool.waitingCount > waitingBaseline, 300)).toBe(true);
      await delay(25);
      const peakWaiting = database.pool.waitingCount;
      const health = await app.inject({ method: "GET", url: "/health" });
      const responses = await bounded(Promise.all(probes), 2_500);
      const returnedToBaseline = await waitFor(
        () => database.pool.waitingCount === waitingBaseline,
        750,
      );
      const underlyingSettled = await transactionPromisesSettled(transaction.mock.results);

      expect({
        health: health.statusCode,
        statuses: responses.map((response) => response.statusCode),
        underlyingProbes: transaction.mock.calls.length,
        peakWaiting,
        waitingAfterResponses: database.pool.waitingCount,
        returnedToBaseline,
        underlyingSettled,
      }).toEqual({
        health: 200,
        statuses: [503, 503, 503, 503, 503],
        underlyingProbes: 1,
        peakWaiting: 1,
        waitingAfterResponses: waitingBaseline,
        returnedToBaseline: true,
        underlyingSettled: true,
      });

      for (const client of held.splice(0)) client.release();
      const recovered = await bounded(app.inject({ method: "GET", url: "/ready" }), 2_000);
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toEqual({ status: "ready" });
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(await transactionPromisesSettled(transaction.mock.results)).toBe(true);
      expect(database.pool.waitingCount).toBe(waitingBaseline);
    } finally {
      for (const client of held) client.release();
      await waitFor(() => database.pool.waitingCount === 0, 2_000);
      await app.close();
    }
  });
});

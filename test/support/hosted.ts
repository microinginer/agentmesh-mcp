import type { FastifyInstance, LightMyRequestResponse } from "fastify";

export interface TestClock {
  now(): Date;
  set(iso: string): void;
}

export function createTestClock(initialIso: string): TestClock {
  let current = new Date(initialIso);

  return {
    now: () => new Date(current),
    set: (iso) => {
      current = new Date(iso);
    },
  };
}

export function firstCookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return typeof first === "string" ? (first.split(";", 1)[0] ?? "") : "";
}

export function createOwnerClient(input: {
  app: FastifyInstance;
  cookie: string;
  csrf: string;
  origin: string;
}): { get(path: string): Promise<LightMyRequestResponse> } {
  return {
    get: (path) =>
      input.app.inject({
        method: "GET",
        url: path,
        headers: {
          cookie: input.cookie,
          "x-csrf-token": input.csrf,
          origin: input.origin,
        },
      }),
  };
}

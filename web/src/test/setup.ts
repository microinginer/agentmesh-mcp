import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { api } from "./render";
import { setDocumentVisibility } from "./visibility";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: createMemoryStorage(),
});
Object.defineProperty(window, "sessionStorage", {
  configurable: true,
  value: createMemoryStorage(),
});

beforeEach(() => {
  vi.stubGlobal("location", {
    ...window.location,
    assign: vi.fn(),
  });
  api.reset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  setDocumentVisibility("visible");
});

afterEach(() => {
  cleanup();
  api.reset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setDocumentVisibility("visible");
  vi.unstubAllGlobals();
});

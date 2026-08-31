import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:43123";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: join(tmpdir(), "agentmesh-playwright"),
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "pnpm --dir .. build && pnpm --dir .. exec tsx web/e2e/server.ts",
    url: `${baseURL}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 2_000 },
  },
});

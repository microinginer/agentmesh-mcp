import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentMeshDatabase } from "../src/db/client.js";
import { buildHttpApp } from "../src/http.js";

const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const indexHtml = "<!doctype html><html><body><div id=\"root\">AgentMesh web shell</div></body></html>";

let webAssetsPath: string;

beforeEach(async () => {
  webAssetsPath = await mkdtemp(join(tmpdir(), "agentmesh-web-static-"));
  await mkdir(join(webAssetsPath, "assets"));
  await writeFile(join(webAssetsPath, "index.html"), indexHtml, "utf8");
  await writeFile(join(webAssetsPath, "assets", "app-a1b2c3d4.js"), "globalThis.__agentmesh = true;", "utf8");
  await writeFile(join(webAssetsPath, "assets", ".hidden-a1b2c3d4.js"), "secret", "utf8");
});

afterEach(async () => {
  await rm(webAssetsPath, { recursive: true, force: true });
});

function buildApp(assetsPath = webAssetsPath) {
  return buildHttpApp({
    db: {} as AgentMeshDatabase,
    signingKey,
    projectService: {
      authenticateProject: async () => {
        throw new Error("not expected");
      },
    },
    host: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost"],
    admin: null,
    logger: { write: () => {} },
    readinessCheck: async () => true,
    webAssetsPath: assetsPath,
  });
}

describe("AgentMesh web static boundary", () => {
  it("serves the product shell without intercepting protected server routes", async () => {
    const app = buildApp();
    try {
      const landing = await app.inject({ method: "GET", url: "/" });
      const projectRoute = await app.inject({ method: "GET", url: "/app/projects/example" });
      const opsRoute = await app.inject({ method: "GET", url: "/ops/projects/example" });
      const unknownApi = await app.inject({ method: "GET", url: "/api/v1/not-real" });
      const mcpGet = await app.inject({ method: "GET", url: "/mcp" });

      expect(landing.statusCode).toBe(200);
      expect(landing.headers["content-type"]).toContain("text/html");
      expect(projectRoute.body).toBe(landing.body);
      expect(opsRoute.body).toBe(landing.body);
      expect(unknownApi.statusCode).toBe(404);
      expect(mcpGet.statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });

  it("keeps every protected server prefix outside the SPA fallback", async () => {
    const app = buildApp();
    try {
      const paths = [
        "/api/not-real",
        "/auth/not-real",
        "/mcp/not-real",
        "/health/not-real",
        "/ready/not-real",
        "/admin/not-real",
        "/api/admin/not-real",
      ];
      const responses = await Promise.all(paths.map((url) => app.inject({ method: "GET", url })));

      expect(responses.map((response) => response.statusCode)).toEqual(paths.map(() => 404));
      expect(responses.every((response) => response.body !== indexHtml)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("uses immutable caching only for hashed assets and no-cache for HTML", async () => {
    const app = buildApp();
    try {
      const html = await app.inject({ method: "GET", url: "/app" });
      const asset = await app.inject({ method: "GET", url: "/assets/app-a1b2c3d4.js" });

      expect(html.headers["cache-control"]).toBe("no-cache");
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(asset.headers["content-type"]).toContain("javascript");
    } finally {
      await app.close();
    }
  });

  it("applies the product CSP without weakening transport headers", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/" });

      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
          + "img-src 'self' data: https://avatars.githubusercontent.com https://github.com; "
          + "base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    } finally {
      await app.close();
    }
  });

  it("never exposes source maps, dotfiles, or traversal-shaped paths", async () => {
    const app = buildApp();
    try {
      const paths = [
        "/assets/app-a1b2c3d4.js.map",
        "/assets/.hidden-a1b2c3d4.js",
        "/.env",
        "/app/.env",
        "/app/%2e%2e/api/v1/not-real",
        "/app/%2E%2E/admin",
        "/%61pi/v1/not-real",
      ];
      const responses = await Promise.all(paths.map((url) => app.inject({ method: "GET", url })));

      expect(responses.map((response) => response.statusCode)).toEqual(paths.map(() => 404));
      expect(responses.every((response) => response.body !== indexHtml)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("fails closed when the compiled web directory is missing", async () => {
    const missing = join(webAssetsPath, "missing");
    const app = buildApp(missing);
    try {
      const html = await app.inject({ method: "GET", url: "/" });
      const api = await app.inject({ method: "GET", url: "/api/v1/not-real" });

      expect(html.statusCode).toBe(503);
      expect(html.json()).toEqual({ error: "web_assets_unavailable" });
      expect(api.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("fails closed when index exists without its compiled asset directory", async () => {
    await rm(join(webAssetsPath, "assets"), { recursive: true, force: true });
    const app = buildApp();
    try {
      const html = await app.inject({ method: "GET", url: "/app/projects/example" });

      expect(html.statusCode).toBe(503);
      expect(html.json()).toEqual({ error: "web_assets_unavailable" });
    } finally {
      await app.close();
    }
  });
});

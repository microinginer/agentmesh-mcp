import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentMeshDatabase } from "../src/db/client.js";
import { buildHttpApp } from "../src/http.js";

const signingKey = Buffer.from("agentmesh-test-signing-key-32-bytes!", "utf8");
const indexHtml = "<!doctype html><html><body><div id=\"root\">AgentMesh web shell</div>"
  + "<script type=\"module\" src=\"/assets/app-a1b2c3d4.js\"></script></body></html>";

let webAssetsPath: string;

beforeEach(async () => {
  webAssetsPath = await mkdtemp(join(tmpdir(), "agentmesh-web-static-"));
  await mkdir(join(webAssetsPath, "assets"));
  await writeFile(join(webAssetsPath, "index.html"), indexHtml, "utf8");
  await writeFile(join(webAssetsPath, "assets", "app-a1b2c3d4.js"), "globalThis.__agentmesh = true;", "utf8");
  await writeFile(join(webAssetsPath, "assets", ".hidden-a1b2c3d4.js"), "secret", "utf8");
  await writeFile(join(webAssetsPath, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8");
  await writeFile(join(webAssetsPath, "site.webmanifest"), "{}", "utf8");
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
      const guideRoute = await app.inject({ method: "GET", url: "/guide" });
      const projectRoute = await app.inject({ method: "GET", url: "/app/projects/example" });
      const opsRoute = await app.inject({ method: "GET", url: "/ops/projects/example" });
      const unknownApi = await app.inject({ method: "GET", url: "/api/v1/not-real" });
      const mcpGet = await app.inject({ method: "GET", url: "/mcp" });

      expect(landing.statusCode).toBe(200);
      expect(landing.headers["content-type"]).toContain("text/html");
      expect(guideRoute.body).toBe(landing.body);
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

  it("serves only named root brand assets with web security headers", async () => {
    const app = buildApp();
    try {
      const icon = await app.inject({ method: "GET", url: "/favicon.svg" });
      const manifest = await app.inject({ method: "HEAD", url: "/site.webmanifest" });
      const unlisted = await app.inject({ method: "GET", url: "/robots.txt" });

      expect(icon.statusCode).toBe(200);
      expect(icon.headers["content-type"]).toContain("image/svg+xml");
      expect(icon.headers["cache-control"]).toBe("no-cache");
      expect(icon.headers["content-security-policy"]).toBeDefined();
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers["content-type"]).toContain("application/manifest+json");
      expect(manifest.body).toBe("");
      expect(unlisted.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("keeps successful HTML and hashed-asset HEAD responses bodyless", async () => {
    const app = buildApp();
    try {
      const html = await app.inject({ method: "HEAD", url: "/app/projects/example" });
      const asset = await app.inject({ method: "HEAD", url: "/assets/app-a1b2c3d4.js" });

      expect(html.statusCode).toBe(200);
      expect(html.headers["cache-control"]).toBe("no-cache");
      expect(html.body).toBe("");
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(asset.body).toBe("");
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

  it("fails closed without filesystem disclosure when index HTML becomes corrupt", async () => {
    const app = buildApp();
    await app.ready();
    await writeFile(join(webAssetsPath, "index.html"), "not an AgentMesh document", "utf8");
    try {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/" }),
        app.inject({ method: "GET", url: "/app/projects/example" }),
        app.inject({ method: "HEAD", url: "/app/projects/example" }),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(503);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).not.toContain(webAssetsPath);
        expect(response.body).not.toContain("index.html");
      }
      expect(responses[0]?.json()).toEqual({ error: "web_assets_unavailable" });
      expect(responses[1]?.json()).toEqual({ error: "web_assets_unavailable" });
      expect(responses[2]?.body).toBe("");
    } finally {
      await app.close();
    }
  });

  it("fails closed without filesystem disclosure when index HTML becomes unreadable", async () => {
    const indexPath = join(webAssetsPath, "index.html");
    const app = buildApp();
    await app.ready();
    await chmod(indexPath, 0o000);
    try {
      const response = await app.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(503);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ error: "web_assets_unavailable" });
      expect(response.body).not.toContain(webAssetsPath);
      expect(response.body).not.toContain("index.html");
    } finally {
      await chmod(indexPath, 0o600);
      await app.close();
    }
  });

  it("redacts unreadable hashed-asset failures and removes immutable caching", async () => {
    const assetPath = join(webAssetsPath, "assets", "app-a1b2c3d4.js");
    const app = buildApp();
    await app.ready();
    await chmod(assetPath, 0o000);
    try {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/assets/app-a1b2c3d4.js" }),
        app.inject({ method: "HEAD", url: "/assets/app-a1b2c3d4.js" }),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(503);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["cache-control"]).not.toContain("immutable");
        expect(response.body).not.toContain(webAssetsPath);
        expect(response.body).not.toContain("app-a1b2c3d4.js");
      }
      expect(responses[0]?.json()).toEqual({ error: "web_assets_unavailable" });
      expect(responses[1]?.body).toBe("");
    } finally {
      await chmod(assetPath, 0o600);
      await app.close();
    }
  });

  it("treats an empty referenced asset build as unavailable", async () => {
    await rm(join(webAssetsPath, "assets", "app-a1b2c3d4.js"));
    const app = buildApp();
    try {
      const html = await app.inject({ method: "GET", url: "/" });
      const api = await app.inject({ method: "GET", url: "/api/v1/not-real" });

      expect(html.statusCode).toBe(503);
      expect(html.headers["cache-control"]).toBe("no-store");
      expect(html.json()).toEqual({ error: "web_assets_unavailable" });
      expect(api.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

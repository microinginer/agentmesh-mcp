import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("public repository hygiene", () => {
  it("keeps durable Blackboard writes gated while routine coordination tools are approved", () => {
    const config = readFileSync(".codex/config.toml", "utf8");
    const approvalModes = Object.fromEntries(
      [...config.matchAll(
        /\[mcp_servers\.agentmesh\.tools\.(agentmesh_[a-z_]+)\]\s+approval_mode = "([a-z]+)"/g,
      )].map((match) => [match[1], match[2]]),
    );

    expect(approvalModes).toEqual({
      agentmesh_sync: "approve",
      agentmesh_list_agents: "approve",
      agentmesh_get_facts: "approve",
      agentmesh_report_progress: "approve",
      agentmesh_set_fact: "prompt",
    });
  });

  it("ships the expected community and security entry points", () => {
    for (const path of [
      "LICENSE",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "CHANGELOG.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/bug.yml",
      ".github/ISSUE_TEMPLATE/feature.yml",
      ".github/workflows/ci.yml",
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("does not track local secrets, build output, or IDE state", () => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
    expect(tracked).not.toContain(".env");
    expect(tracked.some((path) => path.startsWith("dist/"))).toBe(false);
    expect(tracked.some((path) => path.startsWith(".idea/"))).toBe(false);
  });

  it("installs the browser from the workspace that owns Playwright", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("pnpm --dir web exec playwright install --with-deps chromium");
  });

  it("gates releases on production dependency audit", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("pnpm audit --prod");
  });
});

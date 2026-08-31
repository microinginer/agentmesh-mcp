import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("public repository hygiene", () => {
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
});

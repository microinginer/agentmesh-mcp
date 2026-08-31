import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("production operations scripts", () => {
  it("rejects an invalid deploy digest before touching Docker", () => {
    const result = spawnSync("bash", ["deploy/scripts/deploy.sh", "not-a-digest"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid image digest");
    expect(result.stdout).toBe("");
  });

  it("keeps backup and restore scripts syntactically valid and fail-closed", () => {
    for (const path of ["deploy/scripts/backup.sh", "deploy/scripts/restore-check.sh"]) {
      expect(() => execFileSync("bash", ["-n", path], { cwd: process.cwd() })).not.toThrow();
      const source = readFileSync(path, "utf8");
      expect(source).toContain("set -euo pipefail");
      expect(source).toContain("umask 077");
      expect(source).not.toContain("set -x");
      expect(source).not.toContain("rm -rf");
    }
  });
});

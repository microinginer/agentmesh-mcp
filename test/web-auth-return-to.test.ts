import { describe, expect, it } from "vitest";

import { safeReturnTo } from "../src/web-auth/routes.js";

describe("OAuth return_to validation", () => {
  it.each([
    ["/app", "/app"],
    ["/ops", "/ops"],
    [encodeURIComponent("/app/projects/00000000-0000-4000-8000-000000000001/settings"),
      "/app/projects/00000000-0000-4000-8000-000000000001/settings"],
    [encodeURIComponent("/ops/users"), "/ops/users"],
    [encodeURIComponent("/ops/projects?status=active#results"), "/ops/projects?status=active#results"],
    [encodeURIComponent("/ops/users?search=Jane%20Doe"), "/ops/users?search=Jane%20Doe"],
  ])("accepts a canonical target encoded at most once: %s", (raw, expected) => {
    expect(safeReturnTo(raw)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "https://attacker.example/app",
    encodeURIComponent("https://attacker.example/app"),
    "//attacker.example/app",
    encodeURIComponent("//attacker.example/app"),
    "/app\\windows",
    encodeURIComponent("/ops\\windows"),
    "/app/../secret",
    encodeURIComponent("/ops/../app"),
    "/app/%2e%2e/secret",
    encodeURIComponent("/ops/\nLocation:evil"),
    encodeURIComponent(encodeURIComponent("/ops/users")),
    encodeURIComponent("/ops/users?next=%252Fapp"),
    "%E0%A4%A",
  ])("falls back for an unsafe or multiply encoded target: %s", (raw) => {
    expect(safeReturnTo(raw)).toBe("/app");
  });
});

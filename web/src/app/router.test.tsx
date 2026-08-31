import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TestApp } from "../test/render";

describe("AgentMesh application router", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders the restrained public shell", () => {
    render(<TestApp />);

    expect(screen.getByRole("heading", { name: "AgentMesh" })).toBeInTheDocument();
    expect(screen.getByText("Your agents, working as one.")).toBeInTheDocument();
  });

  it("provides an isolated full-page navigation spy", () => {
    expect(vi.isMockFunction(window.location.assign)).toBe(true);

    window.location.assign("/auth/github/start");

    expect(window.location.assign).toHaveBeenCalledWith("/auth/github/start");
  });

  it.each([
    ["/app/projects/example", "AgentMesh application"],
    ["/ops/projects/example", "AgentMesh operations"],
  ])("routes %s into the expected product surface", (path, label) => {
    render(<TestApp initialEntries={[path]} />);

    expect(screen.getByRole("main", { name: label })).toBeInTheDocument();
  });
});

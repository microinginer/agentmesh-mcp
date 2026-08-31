import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TestApp } from "../test/render";

describe("AgentMesh application router", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders the restrained public shell", () => {
    render(<TestApp />);

    expect(screen.getByRole("heading", { name: "Your agents, working as one." })).toBeInTheDocument();
    expect(screen.getByText("AgentMesh")).toBeInTheDocument();
  });

  it("provides an isolated full-page navigation spy", () => {
    expect(vi.isMockFunction(window.location.assign)).toBe(true);

    window.location.assign("/auth/github/start");

    expect(window.location.assign).toHaveBeenCalledWith("/auth/github/start");
  });

  it("gates the owner workspace behind the server session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: {
        code: "AUTH_REQUIRED",
        message: "Authentication is required",
        request_id: "router-test-request",
      },
    }, { status: 401 })));

    render(<TestApp initialEntries={["/app"]} />);

    expect(await screen.findByRole("heading", { name: "Sign in to AgentMesh" })).toBeInTheDocument();
  });

  it("keeps the operator surface isolated", () => {
    render(<TestApp initialEntries={["/ops/projects/example"]} />);

    expect(screen.getByRole("main", { name: "AgentMesh operations" })).toBeInTheDocument();
  });
});

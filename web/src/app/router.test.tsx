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

  it("returns a clear 403 surface to an authenticated non-operator", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        github_id: "101",
        login: "agentmesh-owner",
        display_name: "AgentMesh Owner",
        avatar_url: null,
      },
      operator: false,
      authenticated_at: "2026-08-31T10:00:00.000Z",
      csrf_token: "agentmesh-test-csrf-token-32-bytes-long",
    })));

    render(<TestApp initialEntries={["/ops/projects/example"]} />);

    expect(await screen.findByRole("heading", { name: "Operator access required" })).toBeInTheDocument();
    expect(screen.getByText("403")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to workspace" })).toHaveAttribute("href", "/app");
  });
});

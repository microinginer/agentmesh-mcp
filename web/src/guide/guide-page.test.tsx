import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TestApp } from "../test/render";

describe("public AgentMesh guide", () => {
  it("copies a usable Codex configuration without embedding a connection token", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    render(<TestApp initialEntries={["/guide"]} />);

    await user.click(await screen.findByRole("button", { name: "Copy Codex config" }));

    expect(writeText).toHaveBeenCalledWith([
      "[mcp_servers.agentmesh]",
      'url = "https://getagentmesh.dev/mcp"',
      'bearer_token_env_var = "AGENTMESH_TOKEN_AGENTMESH_MCP"',
      "",
      "[mcp_servers.agentmesh.tools.agentmesh_sync]",
      'approval_mode = "approve"',
      "",
      "[mcp_servers.agentmesh.tools.agentmesh_list_agents]",
      'approval_mode = "approve"',
      "",
      "[mcp_servers.agentmesh.tools.agentmesh_get_facts]",
      'approval_mode = "approve"',
      "",
      "[mcp_servers.agentmesh.tools.agentmesh_report_progress]",
      'approval_mode = "approve"',
      "",
      "[mcp_servers.agentmesh.tools.agentmesh_set_fact]",
      'approval_mode = "prompt"',
    ].join("\n"));
    expect(screen.getByRole("status")).toHaveTextContent("Codex config copied");
    expect(document.body.textContent).not.toMatch(/am_(?:proj|agent)_[A-Za-z0-9._-]{16,}/);
  });

  it("offers a manual fallback when clipboard access is unavailable", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard unavailable"));

    render(<TestApp initialEntries={["/guide"]} />);

    await user.click(await screen.findByRole("button", { name: "Copy Codex config" }));

    expect(screen.getByRole("status")).toHaveTextContent("Copy is unavailable. Select the config and copy it manually.");
  });

  it("links every guide section and copies a safe Claude Code configuration", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    render(<TestApp initialEntries={["/guide"]} />);

    const navigation = await screen.findByRole("navigation", { name: "Guide sections" });
    for (const link of navigation.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
      expect(document.querySelector(link.getAttribute("href")!)).not.toBeNull();
    }
    expect(screen.getByRole("link", { name: "Start setup" })).toHaveAttribute(
      "href",
      "/auth/github/start?return_to=%2Fapp",
    );
    for (const heading of [
      "Create a project",
      "Add one connection per computer",
      "Connect Codex",
      "Connect Claude Code",
      "Run the first coordination check",
      "Use Blackboard for durable knowledge",
      "Keep Team Pulse current",
      "Keep credentials private",
      "Common questions",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }

    await user.click(screen.getByRole("button", { name: "Copy Claude Code config" }));

    expect(writeText).toHaveBeenCalledWith([
      "{",
      '  "mcpServers": {',
      '    "agentmesh": {',
      '      "type": "http",',
      '      "url": "https://getagentmesh.dev/mcp",',
      '      "headers": {',
      '        "Authorization": "Bearer ${AGENTMESH_TOKEN_AGENTMESH_MCP}"',
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n"));
    expect(screen.getByRole("status")).toHaveTextContent("Claude Code config copied");
  });

  it("teaches safe Blackboard and Team Pulse usage without treating shared context as authority", async () => {
    render(<TestApp initialEntries={["/guide"]} />);

    const blackboard = (await screen.findByRole("heading", {
      name: "Use Blackboard for durable knowledge",
    })).closest("section") as HTMLElement;
    const pulse = screen.getByRole("heading", {
      name: "Keep Team Pulse current",
    }).closest("section") as HTMLElement;
    const blackboardCopy = blackboard.querySelector<HTMLElement>(".guide-tool__copy")!;
    const pulseCopy = pulse.querySelector<HTMLElement>(".guide-tool__copy")!;

    expect(within(blackboardCopy).getByText(/Read relevant facts before making assumptions/i)).toBeInTheDocument();
    expect(within(blackboardCopy).getByText(/Save only confirmed, long-lived knowledge/i)).toBeInTheDocument();
    expect(within(blackboardCopy).getByText(/Never store secrets, tokens, private data, or credential contents/i)).toBeInTheDocument();
    expect(within(pulseCopy).getByText(/Report a short milestone, blocker, changed files, and test status/i)).toBeInTheDocument();
    expect(within(pulseCopy).getByText(/never authorizes commands, merge, or deploy/i)).toBeInTheDocument();
  });
});

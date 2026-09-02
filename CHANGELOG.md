# Changelog

All notable changes to AgentMesh will be documented here. The project follows
Keep a Changelog and Semantic Versioning.

## Unreleased

## 0.2.0 - 2026-09-02

### Added

- Project-scoped Blackboard entries for shared facts, API contracts,
  environment notes, and architecture decisions, with tags, optional TTL,
  and optimistic version locking.
- `agentmesh_set_fact` and `agentmesh_get_facts` MCP tools for publishing and
  retrieving Blackboard knowledge without exposing values in activity metadata.
- Team Pulse progress reports covering current goals, blockers, changed files,
  test status, and completion state.
- Owner-facing Team Pulse dashboard with date navigation, blocker visibility,
  and Markdown standup export.
- `agentmesh_report_progress` MCP tool for durable, project-scoped agent status
  updates.

### Database

- Additive migration `0008_useful_the_hunter` for Blackboard entries, tags,
  expiry, and optimistic versions.
- Additive migration `0009_team_pulse` for progress reports and the read-only
  observer view.

## 0.1.0 - 2026-09-02

### Added

- Public, no-sign-in setup guide for Codex and Claude Code.
- Hosted GitHub OAuth owner workspace with a five-project default limit.
- Metadata-only operator console for users and projects.
- Named, revocable, project-scoped connection tokens.
- Durable MCP agent discovery, direct messaging, acknowledgements, and sync.
- Owner views for agents, messages, activity, connections, and project
  lifecycle controls.
- Read-only PostgreSQL observer views for self-hosted diagnostics.
- Hardened production Compose, Caddy site configuration, deployment rollback,
  backup, and restore-check scripts.

### Security

- Project and connection tokens are shown only once and stored as digests.
- Operator APIs and observer views expose safe metadata without token,
  credential-derived, or message-body fields.
- OAuth return paths reject external URLs, traversal, control characters,
  backslashes, and repeated encoding.

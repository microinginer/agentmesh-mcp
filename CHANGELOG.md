# Changelog

All notable changes to AgentMesh will be documented here. The project follows
Keep a Changelog and Semantic Versioning.

## Unreleased

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

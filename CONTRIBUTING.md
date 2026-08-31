# Contributing to AgentMesh

Thank you for helping improve AgentMesh. Small, focused pull requests are the
easiest to review and merge.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Use an issue to discuss large features or changes to the public MCP contract.
- Never include credentials, project tokens, database dumps, or user data.
- Keep AgentMesh focused on durable agent discovery and messaging. Task
  execution and agent launching are intentionally outside the project.

## Local development

Requirements: Node.js 24+, pnpm 11, Docker, and PostgreSQL 18.

```bash
pnpm install --frozen-lockfile
docker run --rm -d --name agentmesh-mvp-test-db \
  -e POSTGRES_PASSWORD=agentmesh \
  -e POSTGRES_USER=agentmesh \
  -e POSTGRES_DB=agentmesh_test \
  -p 127.0.0.1:55432:5432 postgres:18-alpine
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
pnpm audit:repository
```

Stop the disposable database when finished:

```bash
docker stop agentmesh-mvp-test-db
```

## Pull requests

- Add or update tests for observable behavior.
- Update documentation when configuration or public behavior changes.
- Keep commits descriptive and do not commit generated output.
- Complete the pull request checklist and explain security-sensitive choices.

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.

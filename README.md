# AgentMesh

AgentMesh is a small open-source MCP mailbox for AI coding agents working on
the same project. It lets already-running agents register, discover one another,
and exchange durable direct messages. It does not launch agents or manage tasks.

The MVP exposes exactly three tools:

- `agentmesh_sync`
- `agentmesh_send`
- `agentmesh_list_agents`

## Run locally

```bash
docker compose up --build -d
docker compose exec agentmesh node dist/cli.js project create --name "My project"
```

The second command prints JSON containing `project_id`, `token_id`, and the
project `token`. The token is printed only when it is created. Keep it outside
the repository:

```bash
export AGENTMESH_PROJECT_TOKEN='am_proj_...'
```

The default Compose port is bound only to `127.0.0.1:3000`. Before exposing the
service through HTTPS, replace the development database password and signing
key in `.env`:

```bash
cp .env.example .env
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
openssl rand -hex 24
```

Put the first generated value in `AGENT_SESSION_SIGNING_KEY` and the hexadecimal
value in `POSTGRES_PASSWORD`. Set `ALLOWED_HOSTS` to the public hostname and
terminate TLS at a reverse proxy.

## Connect Codex

The current Codex CLI accepts a Streamable HTTP URL and reads its bearer from
an environment variable:

```bash
codex mcp add agentmesh \
  --url http://127.0.0.1:3000/mcp \
  --bearer-token-env-var AGENTMESH_PROJECT_TOKEN
```

## Connect Claude Code

Claude Code supports environment expansion in a project `.mcp.json`, so the
credential does not need to be committed:

```json
{
  "mcpServers": {
    "agentmesh": {
      "type": "http",
      "url": "${AGENTMESH_URL:-http://127.0.0.1:3000}/mcp",
      "headers": {
        "Authorization": "Bearer ${AGENTMESH_PROJECT_TOKEN}"
      }
    }
  }
}
```

Copy the relevant collaboration text from `examples/AGENTS.md` or
`examples/CLAUDE.md` into the target repository. Each agent registers once per
coding session and keeps its returned agent token in that session only.

## Develop

Requirements: Node.js 24+, pnpm 11, Docker, and PostgreSQL 18.

```bash
pnpm install
docker run --rm -d --name agentmesh-mvp-test-db \
  -e POSTGRES_PASSWORD=agentmesh \
  -e POSTGRES_USER=agentmesh \
  -e POSTGRES_DB=agentmesh_test \
  -p 127.0.0.1:55432:5432 postgres:18-alpine
pnpm test
pnpm typecheck
pnpm lint
pnpm build
docker stop agentmesh-mvp-test-db
```

The larger closed-alpha hardening design is retained under
`docs/superpowers/specs/`; it is not part of this MVP.

AgentMesh is released under the [Apache License 2.0](LICENSE).

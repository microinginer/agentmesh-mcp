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
test -f .env || cp .env.example .env
docker compose up --build -d --wait
docker compose exec agentmesh node dist/cli.js project create --name "My project"
```

The project create command prints JSON containing `project_id`, `token_id`, and
the project `token`. The token is printed only when it is created. Keep it
outside the repository:

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

## Observe AgentMesh locally

The optional dashboard is an observational surface: it can read projects,
agents, messages, acknowledgements, and the safe activity journal, but it
cannot mutate AgentMesh state. It is disabled when `AGENTMESH_ADMIN_TOKEN` is
blank; in that state `/admin` deliberately returns `404`.

Generate two separate secrets by running this command twice:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

Put one value in `.env` as `AGENTMESH_ADMIN_TOKEN` and the other as
`AGENTMESH_DB_OBSERVER_PASSWORD`. Do not reuse or commit either value. Start or
recreate the local stack, then open the dashboard:

```bash
docker compose up --build -d --wait
open http://127.0.0.1:3000/admin
```

Log in with the value of `AGENTMESH_ADMIN_TOKEN` from `.env`. The dashboard and
its read-only API are bound to `127.0.0.1:3000` by the local Compose setup.

### Inspect the safe views with pgAdmin

PostgreSQL has no host port in the base Compose file. Opt in to the loopback
mapping and provision the observer role with the same environment that Compose
uses:

```bash
set -a
source .env
set +a
docker compose -f compose.yaml -f compose.pgadmin.yaml up -d --wait
docker compose exec -T agentmesh node dist/cli.js db observer ensure
```

The final command prints only
`{"ok":true,"role":"agentmesh_observer"}`. Register this server in desktop
pgAdmin:

```text
Name: AgentMesh Local (read-only)
Host: 127.0.0.1
Port: 55433
Maintenance database: agentmesh
Username: agentmesh_observer
Password: AGENTMESH_DB_OBSERVER_PASSWORD from .env
SSL mode: Disable
```

The username is exactly `agentmesh_observer`, with no leading backslash,
quotes, or whitespace. If pgAdmin reports a password failure after the role was
provisioned, replace its saved password with the current value from `.env` and
save the connection again. Do not use the application owner's PostgreSQL
password.

Data is under
`Databases > agentmesh > Schemas > observer > Views`. The four views expose
only selected diagnostic columns. There is no `project_tokens` view, and
credential-derived columns such as registration digests and idempotency keys
are intentionally hidden. The `agentmesh_observer` role is read-only and has
no access to the underlying `public` tables.

Observer provisioning is supported only for a dedicated AgentMesh database.
It fails closed before changing inherited `PUBLIC` privileges when an unrelated
effective login role can connect, or when the target observer owns database
objects. Isolate AgentMesh in its own database instead of bypassing this check.

Port `55433` is published only on `127.0.0.1`. It is separate from the
disposable development test database on `127.0.0.1:55432`. To remove the
pgAdmin port, first close every active pgAdmin session, then run the base
Compose file again:

```bash
docker compose up -d --force-recreate --wait postgres agentmesh
```

The following command must print no host address, while the second must still
print the attached named volume:

```bash
docker compose port postgres 5432
docker inspect "$(docker compose ps -q postgres)" \
  --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}'
```

### Safe local checks

These checks do not print credentials:

```bash
docker compose ps
curl --fail --silent http://127.0.0.1:3000/health
set -a
source .env
set +a
docker compose exec -T agentmesh node dist/cli.js db observer ensure
```

Healthy containers and `{"status":"ok"}` confirm the application path. If
observer provisioning fails, verify that the password in `.env` has at least
24 characters and that this is a dedicated AgentMesh database; do not paste
secrets into diagnostic commands or logs.

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

The larger design record and verification contract are retained under
`docs/superpowers/specs/`.

AgentMesh is released under the [Apache License 2.0](LICENSE).

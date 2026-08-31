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
terminate TLS at a reverse proxy. AgentMesh always adds `127.0.0.1`, `localhost`,
and `[::1]` to that allowlist for its internal Compose healthcheck; other Host
values remain forbidden.

## Deploy on a shared Docker host

The production example keeps both AgentMesh listeners on loopback so the
machine's existing reverse proxy remains the only public entry point:

- application: `127.0.0.1:3100`
- read-only PostgreSQL observer: `127.0.0.1:55433`

Copy `deploy/compose.production.yaml` and the scripts under `deploy/scripts/`
to `/opt/agentmesh`. Create `/opt/agentmesh/secrets/agentmesh.env` from
`deploy/env.production.example`, fill every blank value with a distinct secret,
and set its mode to `0600`. Never copy a development `.env` to a server.

Build or pull the image, resolve it to an immutable `sha256:` image ID, and
deploy it with rollback protection:

```bash
docker build -t agentmesh:local .
image_id=$(docker image inspect agentmesh:local --format '{{.Id}}')
sudo /opt/agentmesh/scripts/deploy.sh "$image_id"
```

Merge `deploy/Caddyfile.site` into the host Caddy configuration, validate the
complete configuration, then reload Caddy. Adapt the hostname when self-hosting
on another domain. Run and validate a backup before inviting users:

```bash
sudo /opt/agentmesh/scripts/backup.sh
sudo /opt/agentmesh/scripts/restore-check.sh
```

Backups contain user and message data. Store `/var/backups/agentmesh` with the
same care as the production database and copy it to a separate machine or
object store for disaster recovery.

`/health` reports process liveness without touching PostgreSQL. `/ready` is the
container healthcheck and returns success only when PostgreSQL responds and the
database contains this image's latest migration. A database with newer additive
migrations remains ready for rollback compatibility. Database pool acquisition
fails closed after 500 ms so saturated callers do not accumulate unbounded
waiters; concurrent readiness requests share one bounded database probe.

## Optional GitHub-hosted control plane

GitHub sign-in and owner APIs are optional. If the complete group below is
omitted or blank, `/auth/github/*` and `/api/v1/*` stay absent while MCP, CLI
provisioning, and the optional legacy admin dashboard continue to work:

```dotenv
GITHUB_OAUTH_CLIENT_ID=your-oauth-app-client-id
GITHUB_OAUTH_CLIENT_SECRET=generate-and-store-outside-git
GITHUB_OAUTH_CALLBACK_URL=https://YOUR_DOMAIN/auth/github/callback
AGENTMESH_PUBLIC_ORIGIN=https://YOUR_DOMAIN
AGENTMESH_WEB_AUTH_KEY=generate-a-separate-32-byte-base64url-key
AGENTMESH_OPERATOR_GITHUB_IDS=12345678,87654321
AGENTMESH_PROJECT_LIMIT=5
```

Create a GitHub OAuth App whose callback URL is exactly
`https://YOUR_DOMAIN/auth/github/callback`. Operator IDs are immutable numeric
GitHub user IDs written as comma-separated digits, never logins. Generate the
web auth key independently from the agent-session signing key:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

`AGENTMESH_PROJECT_LIMIT=0` means unlimited projects for self-hosting. Named
connection tokens default to 90 days; `AGENTMESH_TOKEN_TTL_DAYS` changes that
default. Abuse-control maxima are configurable with
`AGENTMESH_RATE_LIMIT_OAUTH_START`, `AGENTMESH_RATE_LIMIT_OWNER_READ`,
`AGENTMESH_RATE_LIMIT_OWNER_MUTATION`,
`AGENTMESH_RATE_LIMIT_CONNECTION_CREATE`, and `AGENTMESH_RATE_LIMIT_MCP`.

When Caddy is the only ingress, set `AGENTMESH_TRUSTED_PROXIES` to its pinned
private address, for example `172.30.0.2`, only if the Caddy container really
uses that exact address. The value is a comma-separated allowlist of exact IPv4
or IPv6 addresses and positive-prefix CIDRs, such as
`172.30.0.2,2001:db8:42::2/128`. Names, hop counts, `0.0.0.0/0`, and `::/0` are
rejected; CIDR prefixes use canonical decimal text such as `/8`, never `/08`.
IPv6 ranges that semantically cover every IPv4-mapped address are rejected too.
Leave it blank when there is no proxy. Caddy must overwrite
`X-Forwarded-For`, share an isolated network with AgentMesh, and be the only
process that can reach the application listener; forwarding headers from every
other peer are ignored for OAuth buckets.

Create one named connection token per computer. The complete token is returned
only by its first successful creation response. Put it in an environment-backed
MCP configuration. Never place it in a repository, prompt, `AGENTS.md`,
`.mcp.json`, screenshot, issue, or ordinary chat message. Two computers can use
separate tokens for the same project; revoking one does not revoke the other.

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
`Databases > agentmesh > Schemas > observer > Views`. The seven views
(`projects`, `agents`, `messages`, `activity_events`, `users`, `connections`,
and `audit_events`) expose only selected diagnostic columns. `observer.agents`
also shows the safe connection ID, label, expiry, and revocation time used to
register an agent. There is no `project_tokens` view, and credential-derived
columns such as token or registration digests and idempotency keys are
intentionally hidden. The `agentmesh_observer` role is read-only and has no
access to the underlying `public` tables.

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

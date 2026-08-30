# AgentMesh Production Deployment and Acceptance Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package, publish, deploy, back up, restore-test, and validate AgentMesh at `https://agentmesh.uzmedical.org`, then prove coordination between two physical Codex computers before considering the repository ready for public visibility.

**Architecture:** Build one immutable image containing Fastify and Vite assets. Run it behind Caddy with PostgreSQL on a private Docker network, deploy verified image digests through a manually approved GitHub Actions workflow, retain the previous digest for rollback, and restore-test backups on the server. Acceptance combines public probes, real GitHub OAuth, observer-only database inspection, and a two-computer MCP exchange.

**Tech Stack:** Docker BuildKit, Docker Compose, Caddy, PostgreSQL 18, GitHub Actions, GHCR, OpenSSH, Bash, Node.js 24, Vitest, pgAdmin over SSH tunnel

**Spec:** `docs/superpowers/specs/2026-08-31-agentmesh-hosted-control-plane-design.md`

**Prerequisite Plans:**

- `docs/superpowers/plans/2026-08-31-agentmesh-hosted-backend-implementation.md`
- `docs/superpowers/plans/2026-08-31-agentmesh-web-product-implementation.md`

## Global Constraints

- Start only after both prerequisite plans pass their full release gates.
- Expose only Caddy ports 80 and 443 publicly; bind PostgreSQL only to server loopback `127.0.0.1:55433` for the SSH-tunneled observer workflow, and keep the app private.
- Use exactly `agentmesh.uzmedical.org` and `https://agentmesh.uzmedical.org/auth/github/callback`.
- Never commit, bake into an image, echo, archive, or upload OAuth secrets, cookie keys, operator configuration, database passwords, connection-token secrets, or private SSH keys.
- Deploy an immutable digest and retain the last healthy digest for rollback.
- Run only backward-compatible migrations before switching application traffic.
- Retain seven daily and four weekly backups; prove restoration into an isolated database every week.
- Give pgAdmin access only through an SSH tunnel and the existing observer role/views.
- Keep the GitHub repository private during this plan. Visibility changes, history rewrites, force pushes, releases, and announcements require explicit approval at that exact step.
- Final coordination proof requires two physical computers, not two local processes.
- Use TDD for scripts and configuration validators and commit each reviewable task separately.

---

## File Structure

- `deploy/compose.production.yaml`: digest-pinned app, PostgreSQL, Caddy, private networks, volumes, and health checks.
- `deploy/Caddyfile`: TLS, security headers, compression, request limits, and proxying.
- `deploy/env.production.example`: required names and descriptions without values.
- `deploy/scripts/deploy.sh`: locked digest deploy, readiness, and rollback.
- `deploy/scripts/backup.sh`: atomic PostgreSQL backup and retention.
- `deploy/scripts/restore-check.sh`: isolated restore and invariant checks.
- `deploy/systemd/*`: backup and restore-check services/timers.
- `.github/workflows/ci.yml`: complete verification gate.
- `.github/workflows/image.yml`: verified GHCR image, provenance, SBOM, and digest.
- `.github/workflows/deploy-alpha.yml`: manually approved SSH deployment.
- `scripts/repository-audit.sh`: tracked-file and secret-history gate.
- `scripts/hosted-smoke.ts`: DNS, TLS, HTTP, OAuth-start, and optional MCP probes.
- `scripts/hosted-acceptance.ts`: redacted evidence validator for the two-computer trial.
- `docs/runbooks/*`: rollback, backup, deployment, and acceptance procedures.

### Task 1: Add repository hygiene while keeping the repository private

**Files:**

- Create: `CONTRIBUTING.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `SECURITY.md`
- Create: `CHANGELOG.md`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`
- Create: `.github/ISSUE_TEMPLATE/feature.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/dependabot.yml`
- Create: `.gitleaks.toml`
- Create: `scripts/repository-audit.sh`
- Create: `test/repository-audit.test.ts`
- Modify: `README.md`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:** Produces `pnpm audit:repository`, contributor/security documentation, and non-destructive full-history findings. It does not change repository visibility or history.

- [ ] **Step 1: Add a failing tracked-file policy test**

```ts
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
expect(tracked).not.toContain(".env");
expect(tracked.some((path) => path.startsWith("dist/"))).toBe(false);
for (const path of ["LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md"]) {
  expect(existsSync(path), path).toBe(true);
}
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/repository-audit.test.ts`

Expected: FAIL because community and audit files are incomplete.

- [ ] **Step 3: Add documentation, templates, ignore rules, and the exact audit script**

```bash
#!/usr/bin/env bash
set -euo pipefail
git ls-files -z | while IFS= read -r -d '' path; do
  case "$path" in
    .env.example)
      ;;
    .env|.env.*|dist/*|node_modules/*)
      printf 'forbidden tracked path: %s\n' "$path" >&2
      exit 1
      ;;
  esac
done
gitleaks git --redact --no-banner
gitleaks dir . --redact --no-banner
```

Document Apache-2.0 licensing, setup, architecture, threat reporting, support limits, and hosted-versus-self-hosted behavior. Configure Dependabot weekly for pnpm, Docker, and Actions. After manual classification, `.gitleaks.toml` may allow only exact synthetic-fixture fingerprints with a comment naming the fixture; never add a broad path or rule allowlist.

- [ ] **Step 4: Run policy and history scans**

Run: `pnpm vitest run test/repository-audit.test.ts && pnpm audit:repository`

Expected: PASS or a precise redacted finding list. Classify fixtures separately from real credentials. If a real credential or private author identity requires removal, stop and request approval before any rewrite.

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md CHANGELOG.md README.md .gitignore .github .gitleaks.toml scripts/repository-audit.sh test/repository-audit.test.ts package.json
git commit -m "docs: prepare AgentMesh repository for contributors"
```

### Task 2: Build a hardened image and private Compose topology

**Files:**

- Create: `deploy/compose.production.yaml`
- Create: `deploy/Caddyfile`
- Create: `deploy/env.production.example`
- Create: `test/production-compose.test.ts`
- Modify: `Dockerfile`
- Modify: `.dockerignore`
- Modify: `tsconfig.build.json`
- Modify: `package.json`

**Interfaces:** Consumes `dist/server.js`, `dist/web`, `/health`, and `/ready`; produces a non-root image and a topology where only Caddy has public host ports while PostgreSQL has one loopback-only observer binding.

- [ ] **Step 1: Add a failing topology contract test**

```ts
const compose = YAML.parse(readFileSync("deploy/compose.production.yaml", "utf8"));
expect(compose.services.caddy.ports).toEqual(["80:80", "443:443"]);
expect(compose.services.app.ports).toBeUndefined();
expect(compose.services.postgres.ports).toEqual(["127.0.0.1:55433:5432"]);
expect(compose.services.app.read_only).toBe(true);
expect(compose.services.app.security_opt).toContain("no-new-privileges:true");
expect(compose.services.app.cap_drop).toContain("ALL");
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/production-compose.test.ts`

Expected: FAIL because the production topology does not exist.

- [ ] **Step 3: Implement packaging**

Use a frozen pnpm install, separate server/web build stages, a numeric non-root runtime UID, `NODE_ENV=production`, `sourceMap: false` in `tsconfig.build.json`, disabled Vite source maps, tmpfs `/tmp`, and `/opt/agentmesh/secrets/agentmesh.env`. Put app and PostgreSQL on an internal network. Add bounded health checks, `restart: unless-stopped`, compression, body-size limits, clickjacking/MIME/referrer headers, and automatic HTTPS. Add HSTS only after first TLS and rollback validation.

- [ ] **Step 4: Validate and smoke locally**

Run: `docker compose -f deploy/compose.production.yaml config --quiet`

Run: `docker build -t agentmesh:production-test .`

Run: `docker run --rm --entrypoint sh agentmesh:production-test -c 'test "$(id -u)" -ne 0 && test -f dist/server.js && test -f dist/web/index.html'`

Expected: exit 0; no `.env`, Git metadata, tests, source maps, or secret values in the image.

- [ ] **Step 5: Commit**

```bash
git add deploy/compose.production.yaml deploy/Caddyfile deploy/env.production.example Dockerfile .dockerignore tsconfig.build.json package.json test/production-compose.test.ts
git commit -m "build: add hardened production topology"
```

### Task 3: Add CI and verified GHCR publication

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/image.yml`
- Create: `test/github-workflows.test.ts`
- Modify: `.github/dependabot.yml`

**Interfaces:** Produces pull-request verification and `ghcr.io/microinginer/agentmesh-mcp@sha256:<digest>` only after verification. CI is read-only; publishing alone gets `packages: write` and `id-token: write`.

- [ ] **Step 1: Add a failing workflow policy test**

```ts
const ci = parseWorkflow(".github/workflows/ci.yml");
const image = parseWorkflow(".github/workflows/image.yml");
expect(ci.permissions.contents).toBe("read");
expect(ci.jobs.verify.services.postgres.image).toBe("postgres:18-alpine");
expect(image.jobs.publish.needs).toContain("verify");
expect(image.jobs.publish.permissions.packages).toBe("write");
```

Define `parseWorkflow(path)` in that test with `YAML.parse(readFileSync(path, "utf8"))` and quote the YAML `on` key.

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/github-workflows.test.ts`

Expected: FAIL because workflows do not exist.

- [ ] **Step 3: Implement workflows**

CI runs formatting, type checks, unit/integration/browser tests, production build, Compose validation, repository audit, and image smoke. Publication repeats the verification dependency, publishes main/version tags, emits the digest, provenance, and SPDX SBOM, and never exposes secrets to pull requests.

- [ ] **Step 4: Verify locally**

Run: `pnpm vitest run test/github-workflows.test.ts && pnpm release:check`

Expected: PASS with no skipped required stage.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/image.yml .github/dependabot.yml test/github-workflows.test.ts
git commit -m "ci: verify and publish immutable AgentMesh images"
```

### Task 4: Add atomic backups and isolated restore checks

**Files:**

- Create: `deploy/scripts/backup.sh`
- Create: `deploy/scripts/restore-check.sh`
- Create: `deploy/systemd/agentmesh-backup.service`
- Create: `deploy/systemd/agentmesh-backup.timer`
- Create: `deploy/systemd/agentmesh-restore-check.service`
- Create: `deploy/systemd/agentmesh-restore-check.timer`
- Create: `docs/runbooks/backups.md`
- Create: `test/backup-scripts.test.ts`

**Interfaces:** Produces custom-format archives under `/var/backups/agentmesh`, seven daily copies, four weekly copies, and a weekly restore result. Consumes the fixed `/opt/agentmesh` deployment and a root-owned environment file.

- [ ] **Step 1: Add failing safety tests**

Assert scripts contain `set -euo pipefail`, `umask 077`, fixed-directory `mktemp`, `pg_dump --format=custom`, `pg_restore --exit-on-error`, atomic `mv`, and exact retention. Assert no `set -x`, wildcard recursive deletion, broad path, or secret output.

- [ ] **Step 2: Run them and verify failure**

Run: `pnpm vitest run test/backup-scripts.test.ts`

Expected: FAIL because scripts and units do not exist.

- [ ] **Step 3: Implement backup and restore validation**

`backup.sh` creates a mode-600 temporary dump, validates it with `pg_restore --list`, atomically renames it, and prunes only validated names in the fixed directory. It retains one Sunday artifact in `weekly/`. `restore-check.sh` creates only `agentmesh_restore_check`, restores the newest dump, checks migrations and required tables/views, records safe counts/status, and drops only that exact database on exit. Timers run daily at 02:30 and restore-test Sunday at 03:30 server-local time.

- [ ] **Step 4: Test with disposable data**

Run: `pnpm vitest run test/backup-scripts.test.ts`

Run in a disposable Compose stack: `BACKUP_DIR=/absolute/path/to/a/new/mktemp-directory deploy/scripts/backup.sh` followed by the same fixed `BACKUP_DIR` for `restore-check.sh`.

Expected: valid archive, successful isolated restore, original data unchanged, no secrets in output. Remove only the exact temporary directory created for the test.

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts deploy/systemd docs/runbooks/backups.md test/backup-scripts.test.ts
git commit -m "ops: add verified PostgreSQL backups"
```

### Task 5: Add digest deployment and automatic rollback

**Files:**

- Create: `deploy/scripts/deploy.sh`
- Create: `.github/workflows/deploy-alpha.yml`
- Create: `docs/runbooks/hosted-alpha.md`
- Create: `test/deploy-script.test.ts`

**Interfaces:** Input is exactly `sha256:<64 lowercase hex>`. Output is a locked deployment under `/opt/agentmesh`, `current.digest`, `previous.digest`, bounded readiness evidence, or a proven rollback.

- [ ] **Step 1: Add a failing safety test**

```ts
const script = readFileSync("deploy/scripts/deploy.sh", "utf8");
expect(script).toContain("flock");
expect(script).toContain("^sha256:[0-9a-f]{64}$");
expect(script).toContain("previous.digest");
expect(script).toContain("/ready");
expect(script).toContain("rollback");
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/deploy-script.test.ts`

Expected: FAIL because digest deployment is absent.

- [ ] **Step 3: Implement the server transaction**

Lock `/run/lock/agentmesh-deploy.lock`, validate the digest, pull the exact GHCR digest, preserve the current digest, run backward-compatible migrations, start the candidate, and poll `/ready` with fixed attempts and timeout. On failure restore the previous digest and prove readiness before exiting nonzero. Never print the environment.

- [ ] **Step 4: Implement manual GitHub deployment**

Use `workflow_dispatch`, required digest input, and GitHub environment approval. Pin the server host key, send only the digest/fixed command over SSH, and keep application secrets on the server. Repository deployment secrets are limited to host, user, key, and known-host entry.

- [ ] **Step 5: Validate invalid input and rollback**

Run: `pnpm vitest run test/deploy-script.test.ts`

Run: `deploy/scripts/deploy.sh sha256:not-a-digest`

Expected: invalid input fails before Docker/network use; a disposable harness proves an unhealthy candidate restores the last healthy digest.

- [ ] **Step 6: Commit**

```bash
git add deploy/scripts/deploy.sh .github/workflows/deploy-alpha.yml docs/runbooks/hosted-alpha.md test/deploy-script.test.ts
git commit -m "ops: add digest deployment and rollback"
```

### Task 6: Add hosted smoke tests and perform first deployment

**Files:**

- Create: `scripts/hosted-smoke.ts`
- Create: `test/hosted-smoke.test.ts`
- Modify: `package.json`
- Modify: `docs/runbooks/hosted-alpha.md`
- Modify: `deploy/Caddyfile`

**Interfaces:** `pnpm smoke:hosted --base-url https://agentmesh.uzmedical.org [--mcp-token-env AGENTMESH_ACCEPTANCE_TOKEN]` returns redacted JSON with probe/status/duration/TLS expiry and no credentials or message content.

- [ ] **Step 1: Add failing probe/redaction tests**

Cover DNS, certificate SAN/expiry, HTTP redirect, `/health`, `/ready`, SPA/assets, OAuth-start redirect, exact callback, empty GitHub scope, security headers, and optional MCP `tools/list`. Inject sentinel cookie/token/code values into error paths and assert output excludes them.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/hosted-smoke.test.ts`

Expected: FAIL because the probe does not exist.

- [ ] **Step 3: Implement dependency-injected probes**

Export `runHostedSmoke({ baseUrl, resolveDns, connectTls, fetch, mcpToken? })`. Use explicit timeouts, cap response bodies, validate redirect hosts exactly, and report safe metadata only.

- [ ] **Step 4: Prepare and deploy**

At execution time obtain the server SSH host/user from the user. Install Docker Engine and Compose, create `/opt/agentmesh` plus `/opt/agentmesh/secrets` least-privilege directories, write production values without displaying them, configure DNS, and deploy the verified digest.

- [ ] **Step 5: Validate TLS, real OAuth, logout, and rollback**

Run: `pnpm smoke:hosted --base-url https://agentmesh.uzmedical.org`

Use a real browser to sign in through GitHub, verify `/app`, log out, and prove the old cookie no longer authorizes `/api/v1/session`. Trigger one controlled unhealthy-candidate rollback in an approved window. Only then enable HSTS, rebuild/redeploy, and rerun smoke.

Create a temporary test session and project, restart only the app container through Compose, wait for readiness, and prove the same session and project remain valid. This is the required restart-persistence check; do not restart or recreate PostgreSQL for it.

- [ ] **Step 6: Commit**

```bash
git add scripts/hosted-smoke.ts test/hosted-smoke.test.ts package.json docs/runbooks/hosted-alpha.md deploy/Caddyfile
git commit -m "test: add hosted AgentMesh smoke checks"
```

### Task 7: Prove coordination from two physical Codex computers

**Files:**

- Create: `scripts/hosted-acceptance.ts`
- Create: `test/hosted-acceptance.test.ts`
- Create: `test/fixtures/hosted-acceptance.ts`
- Create: `docs/runbooks/two-computer-acceptance.md`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:** Input is redacted evidence with two token IDs, two agent IDs, message IDs, ACK IDs, revocation status, and surviving-client health. Output contains no token, message body, OAuth material, cookie, IP, or database credential.

- [ ] **Step 1: Add a failing validator test**

```ts
expect(validateAcceptance(validFixture)).toEqual({ ok: true, errors: [] });
expect(validateAcceptance({ ...validFixture, agentIds: ["same", "same"] }).ok).toBe(false);
expect(validateAcceptance({ ...validFixture, revokedTokenStatus: 200 }).ok).toBe(false);
expect(JSON.stringify(validateAcceptance(secretFixture))).not.toContain("sentinel-secret");
```

The valid fixture has exactly two distinct token and agent IDs, two sent message IDs, two ACK IDs, revoked-token status 401, surviving-token sync status 200, and successful observer/backup checks.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/hosted-acceptance.test.ts`

Expected: FAIL because validator and fixtures do not exist.

- [ ] **Step 3: Implement validator and runbook**

Create one hosted project, issue `primary-mac` and `second-computer` tokens, and transfer each one-time secret privately only to its target computer. Configure each Codex MCP client for `https://agentmesh.uzmedical.org/mcp` without copying secrets into Git or chat.

- [ ] **Step 4: Execute real two-computer trial**

Register one agent per computer, exchange one uniquely identified message/task in each direction, ACK both, and verify web timeline plus `observer.*`. Revoke `second-computer`, prove 401, and prove `primary-mac` still syncs. Capture only IDs/status/timestamps.

- [ ] **Step 5: Reconfirm recovery/security evidence**

Run hosted smoke, repository audit, isolated restore check, observer access through `127.0.0.1:55433`, and direct `public.*` denial for `agentmesh_observer`; then run `pnpm acceptance:hosted --evidence /absolute/path/to/redacted-evidence.json`.

Expected: PASS and no one-time secret in Git, logs, artifacts, or evidence.

- [ ] **Step 6: Commit**

```bash
git add scripts/hosted-acceptance.ts test/hosted-acceptance.test.ts test/fixtures/hosted-acceptance.ts docs/runbooks/two-computer-acceptance.md package.json README.md
git commit -m "test: codify two-computer AgentMesh acceptance"
```

### Task 8: Close private alpha and stop at the public-release decision

**Files:**

- Create: `docs/releases/hosted-alpha-acceptance.md`
- Create: `docs/releases/public-readiness.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md`

**Interfaces:** Produces redacted acceptance evidence, known limitations, rollback digest reference, restore timestamp, and public-readiness checklist. It does not publish anything.

- [ ] **Step 1: Run the clean release gate**

Run: `pnpm install --frozen-lockfile && pnpm release:check`

Run: `docker compose -f deploy/compose.production.yaml config --quiet`

Run: `pnpm smoke:hosted --base-url https://agentmesh.uzmedical.org`

Run: `pnpm acceptance:hosted --evidence /absolute/path/to/redacted-evidence.json`

Expected: PASS and clean `git status --short`.

- [ ] **Step 2: Record private-alpha evidence**

Document tested digest, migration, timestamps, OAuth/logout result, two-computer exchange, revocation, observer, backup/restore, rollback, risks, and commands. Never include secrets, message bodies, IPs, or database credentials.

- [ ] **Step 3: Complete public-readiness review**

Record history/privacy/secret scans, dependency/container vulnerabilities, branch protection, signed release policy, security-reporting route, governance, screenshots, architecture diagram, self-hosted instructions, and hosted limitations. Explicitly record that encrypted off-host backups are required before calling the hosted service generally available.

- [ ] **Step 4: Commit the private report**

```bash
git add docs/releases/hosted-alpha-acceptance.md docs/releases/public-readiness.md CHANGELOG.md README.md
git commit -m "docs: record hosted AgentMesh alpha acceptance"
```

- [ ] **Step 5: Stop for explicit publication approval**

Present separate choices: keep private, make the reviewed current history public, or authorize a reviewed history-cleanup procedure. Do not change visibility, rewrite, force-push, publish a release, or announce the project without that approval.

## Final Verification Matrix

| Boundary | Required evidence |
|---|---|
| Repository | clean tree; license/community/security files; redacted history and working-tree scans |
| Build | frozen install; type/unit/integration/browser gates; production image; no secrets/source maps |
| Network | only 80/443 public; PostgreSQL loopback-only; DNS/TLS; redirect; headers; bounded bodies/timeouts |
| Auth | exact callback; empty scope; real login/logout; invalidated session; no GitHub token persistence |
| Data | private PostgreSQL; observer SSH tunnel; direct `public.*` denial |
| Operations | digest deploy; readiness; rollback; atomic backup; isolated restore |
| Product | one project; two named tokens; two physical agents; two messages and ACKs |
| Revocation | revoked token gets 401; surviving token remains healthy |
| Publication | repository stays private until a separate explicit decision |

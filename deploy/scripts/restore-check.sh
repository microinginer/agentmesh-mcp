#!/usr/bin/env bash
set -euo pipefail
umask 077

deploy_root=${AGENTMESH_DEPLOY_ROOT:-/opt/agentmesh}
backup_dir=${BACKUP_DIR:-/var/backups/agentmesh}
compose_file="$deploy_root/compose.production.yaml"
env_file="$deploy_root/secrets/agentmesh.env"
restore_database=agentmesh_restore_check

[[ $backup_dir == /* ]]
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
compose=(docker compose --env-file "$env_file" -f "$compose_file")
latest=$(find "$backup_dir" -maxdepth 1 -type f -name 'agentmesh-????????T??????Z.dump' -print | sort -r | head -n 1)
[[ -n $latest && $latest =~ ^${backup_dir}/agentmesh-[0-9]{8}T[0-9]{6}Z\.dump$ ]]

cleanup() {
  "${compose[@]}" exec -T postgres dropdb --username=agentmesh --if-exists "$restore_database" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
"${compose[@]}" exec -T postgres createdb --username=agentmesh "$restore_database"
"${compose[@]}" exec -T postgres pg_restore \
  --username=agentmesh \
  --dbname="$restore_database" \
  --exit-on-error \
  --no-owner \
  --no-acl <"$latest" >/dev/null

"${compose[@]}" exec -T postgres psql --username=agentmesh --dbname="$restore_database" --no-psqlrc --tuples-only --command \
  "SELECT CASE WHEN to_regclass('public.projects') IS NOT NULL AND to_regclass('public.agents') IS NOT NULL AND to_regclass('public.messages') IS NOT NULL AND to_regclass('observer.projects') IS NOT NULL THEN 'ok' ELSE 'missing' END" \
  | grep -q 'ok'
printf 'restore check ready\n'

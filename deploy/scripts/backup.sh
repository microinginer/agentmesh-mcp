#!/usr/bin/env bash
set -euo pipefail
umask 077

deploy_root=${AGENTMESH_DEPLOY_ROOT:-/opt/agentmesh}
backup_dir=${BACKUP_DIR:-/var/backups/agentmesh}
compose_file="$deploy_root/compose.production.yaml"
env_file="$deploy_root/secrets/agentmesh.env"

[[ $backup_dir == /* ]]
mkdir -p "$backup_dir" "$backup_dir/weekly"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
compose=(docker compose --env-file "$env_file" -f "$compose_file")

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$backup_dir/agentmesh-$timestamp.dump"
temporary=$(mktemp "$backup_dir/.agentmesh-$timestamp.XXXXXX.dump")
cleanup() {
  if [[ -n ${temporary:-} && -f $temporary ]]; then
    rm -f -- "$temporary"
  fi
}
trap cleanup EXIT

"${compose[@]}" exec -T postgres pg_dump \
  --username=agentmesh \
  --dbname=agentmesh \
  --format=custom \
  --no-owner \
  --no-acl >"$temporary"
"${compose[@]}" exec -T postgres pg_restore --list >/dev/null <"$temporary"
chmod 0600 "$temporary"
mv -- "$temporary" "$final"
temporary=''

if [[ $(date -u +%u) == 7 ]]; then
  weekly_temporary=$(mktemp "$backup_dir/weekly/.agentmesh-$timestamp.XXXXXX.dump")
  cp -- "$final" "$weekly_temporary"
  chmod 0600 "$weekly_temporary"
  mv -- "$weekly_temporary" "$backup_dir/weekly/agentmesh-$timestamp.dump"
fi

prune() {
  local directory=$1
  local keep=$2
  local files=()
  mapfile -d '' files < <(find "$directory" -maxdepth 1 -type f -name 'agentmesh-????????T??????Z.dump' -print0 | sort -zr)
  local index
  for ((index=keep; index<${#files[@]}; index++)); do
    [[ ${files[index]} =~ ^${directory}/agentmesh-[0-9]{8}T[0-9]{6}Z\.dump$ ]]
    rm -f -- "${files[index]}"
  done
}

prune "$backup_dir" 7
prune "$backup_dir/weekly" 4
printf 'backup ready: %s\n' "$(basename "$final")"

#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 || ! $1 =~ ^sha256:[0-9a-f]{64}$ ]]; then
  printf 'invalid image digest\n' >&2
  exit 2
fi

image_digest=$1
deploy_root=${AGENTMESH_DEPLOY_ROOT:-/opt/agentmesh}
compose_file="$deploy_root/compose.production.yaml"
env_file="$deploy_root/secrets/agentmesh.env"
lock_file=${AGENTMESH_DEPLOY_LOCK:-/run/lock/agentmesh-deploy.lock}

exec 9>"$lock_file"
flock -n 9 || {
  printf 'deployment already running\n' >&2
  exit 3
}

test -f "$compose_file"
test -f "$env_file"

write_image_digest() {
  local digest=$1
  local temporary
  temporary=$(mktemp "$deploy_root/secrets/.agentmesh.env.XXXXXX")
  awk '!/^AGENTMESH_IMAGE=/' "$env_file" >"$temporary"
  printf 'AGENTMESH_IMAGE=%s\n' "$digest" >>"$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$env_file"
}

if ! docker image inspect "$image_digest" >/dev/null 2>&1; then
  docker pull "$image_digest" >/dev/null
fi

current_digest=''
if [[ -f "$deploy_root/current.digest" ]]; then
  current_digest=$(<"$deploy_root/current.digest")
  if [[ ! $current_digest =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf 'invalid current digest state\n' >&2
    exit 4
  fi
fi

if [[ -n $current_digest && $current_digest != "$image_digest" ]]; then
  printf '%s\n' "$current_digest" >"$deploy_root/previous.digest"
fi

write_image_digest "$image_digest"
compose=(docker compose --env-file "$env_file" -f "$compose_file")
"${compose[@]}" up -d >/dev/null

ready=false
for _attempt in $(seq 1 40); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3100/ready >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done

if [[ $ready != true ]]; then
  if [[ -n $current_digest ]]; then
    write_image_digest "$current_digest"
    "${compose[@]}" up -d >/dev/null
    for _attempt in $(seq 1 40); do
      if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3100/ready >/dev/null 2>&1; then
        printf 'candidate unhealthy; rollback restored\n' >&2
        exit 5
      fi
      sleep 2
    done
    printf 'candidate unhealthy; rollback failed\n' >&2
    exit 6
  fi
  printf 'candidate unhealthy; no rollback image available\n' >&2
  exit 7
fi

"${compose[@]}" exec -T app node dist/cli.js db observer ensure >/dev/null
printf '%s\n' "$image_digest" >"$deploy_root/current.digest"
printf 'deployment ready\n'

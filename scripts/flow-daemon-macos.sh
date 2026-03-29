#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${1:-$(pwd)}"
POLL_SEC="${POLL_SEC:-8}"
MAX_RESTART="${MAX_RESTART:-999}"
MAX_BACKOFF_SEC="${MAX_BACKOFF_SEC:-60}"
RESUME_PROMPT="${RESUME_PROMPT:-Continue the current task. Run node flow.js resume first, then proceed with the protocol.}"
NO_DANGEROUS_BYPASS="${NO_DANGEROUS_BYPASS:-0}"

if [[ "$POLL_SEC" -lt 1 ]]; then
  echo "POLL_SEC must be >= 1" >&2
  exit 1
fi
if [[ "$MAX_RESTART" -lt 1 ]]; then
  echo "MAX_RESTART must be >= 1" >&2
  exit 1
fi
if [[ "$MAX_BACKOFF_SEC" -lt 1 ]]; then
  echo "MAX_BACKOFF_SEC must be >= 1" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

LOG_DIR="$PROJECT_ROOT/.flowpilot/daemon"
mkdir -p "$LOG_DIR"
STOP_FILE="$LOG_DIR/STOP"
PID_FILE="$LOG_DIR/daemon.pid"

FLOW_CLI=""
if [[ -f "$PROJECT_ROOT/flow.js" ]]; then
  FLOW_CLI="$PROJECT_ROOT/flow.js"
elif [[ -f "$PROJECT_ROOT/dist/flow.js" ]]; then
  FLOW_CLI="$PROJECT_ROOT/dist/flow.js"
else
  echo "Cannot find flow CLI. Expected $PROJECT_ROOT/flow.js or $PROJECT_ROOT/dist/flow.js" >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${EXISTING_PID:-}" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "daemon already running: PID=$EXISTING_PID" >&2
    exit 1
  fi
fi

echo "$$" > "$PID_FILE"
cleanup() {
  rm -f "$PID_FILE"
}
trap cleanup EXIT

get_workflow_status() {
  local progress="$PROJECT_ROOT/.workflow/progress.md"
  if [[ ! -f "$progress" ]]; then
    return 0
  fi
  awk -F':' '/^[^:]+:[[:space:]]*/ {gsub(/^[[:space:]]+|[[:space:]]+$/,"",$2); print $2; exit}' "$progress" || true
}

is_workflow_idle_or_missing() {
  local status="${1:-}"
  if [[ -z "$status" ]]; then
    return 0
  fi
  if [[ "$status" == "idle" || "$status" == "completed" || "$status" == "aborted" ]]; then
    return 0
  fi
  return 1
}

is_reconciling_output() {
  local text="$1"
  local patterns=(
    "reconciling"
    "node flow.js adopt"
    "node flow.js restart"
  )
  for p in "${patterns[@]}"; do
    if [[ "$text" == *"$p"* ]]; then
      return 0
    fi
  done
  return 1
}

is_no_workflow_output() {
  local text="$1"
  local patterns=(
    "no active workflow"
    "waiting for requirement input"
  )
  for p in "${patterns[@]}"; do
    if [[ "$text" == *"$p"* ]]; then
      return 0
    fi
  done
  return 1
}

should_restart() {
  local exit_code="$1"
  local text="$2"
  if [[ "$exit_code" -ne 0 ]]; then
    return 0
  fi
  local patterns=(
    "context window"
    "maximum context"
    "context length"
    "too many tokens"
    "context overflow"
    "compact"
  )
  for p in "${patterns[@]}"; do
    if [[ "$text" == *"$p"* ]]; then
      return 0
    fi
  done
  return 1
}

restart_count=0

while true; do
  if [[ -f "$STOP_FILE" ]]; then
    echo "[daemon] STOP file detected, exiting."
    break
  fi

  status="$(get_workflow_status || true)"
  if [[ -z "${status:-}" ]]; then
    echo "[daemon] no workflow state file yet, waiting."
    sleep "$POLL_SEC"
    continue
  fi
  if is_workflow_idle_or_missing "$status"; then
    echo "[daemon] no active workflow, waiting."
    sleep "$POLL_SEC"
    continue
  fi

  set +e
  resume_output="$(node "$FLOW_CLI" resume 2>&1)"
  resume_code=$?
  set -e
  if [[ "$resume_code" -ne 0 ]]; then
    echo "[daemon] node flow.js resume failed (exit=$resume_code), retry after ${POLL_SEC}s."
    sleep "$POLL_SEC"
    continue
  fi
  if is_no_workflow_output "$resume_output"; then
    echo "[daemon] no active workflow, waiting."
    sleep "$POLL_SEC"
    continue
  fi

  if is_reconciling_output "$resume_output"; then
    echo "[daemon] reconciling detected, wait manual adopt/restart/skip."
    sleep "$POLL_SEC"
    continue
  fi

  ts="$(date +%Y%m%d-%H%M%S)"
  agent_log="$LOG_DIR/codex-$ts.log"

  cmd=(codex exec resume --last)
  if [[ "$NO_DANGEROUS_BYPASS" != "1" ]]; then
    cmd+=(--dangerously-bypass-approvals-and-sandbox)
  fi
  cmd+=("$RESUME_PROMPT")

  set +e
  "${cmd[@]}" 2>&1 | tee "$agent_log"
  code=${PIPESTATUS[0]}
  set -e

  log_text=""
  if [[ -f "$agent_log" ]]; then
    log_text="$(cat "$agent_log")"
  fi

  if should_restart "$code" "$log_text"; then
    restart_count=$((restart_count + 1))
    if [[ "$restart_count" -gt "$MAX_RESTART" ]]; then
      echo "restart limit reached: $restart_count" >&2
      exit 1
    fi
    delay=$((2 ** (restart_count < 6 ? restart_count : 6)))
    if [[ "$delay" -gt "$MAX_BACKOFF_SEC" ]]; then
      delay="$MAX_BACKOFF_SEC"
    fi
    echo "[daemon] restart #$restart_count after ${delay}s."
    sleep "$delay"
    continue
  fi

  restart_count=0
  sleep "$POLL_SEC"
done

#!/bin/bash
# PreToolUse hook for Bash: wraps commands with tee for streaming output
# Receives tool input JSON on stdin, outputs modified input on stdout

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Truncate the output file for this new command
OUTFILE="/tmp/claude-bash-live.log"
> "$OUTFILE"

# Wrap command with tee for streaming, preserving exit code
WRAPPED="set -o pipefail; (${COMMAND}) 2>&1 | stdbuf -oL tee ${OUTFILE}"

# Output modified input using hookSpecificOutput format
WRAPPED_JSON=$(printf '%s' "$WRAPPED" | jq -Rs .)
echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"allow\", \"updatedInput\": {\"command\": ${WRAPPED_JSON}}}}"

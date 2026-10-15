#!/usr/bin/env bash
# Run one finance agent headlessly with Claude Code, e.g. from cron / launchd:
#   scripts/run-agent.sh finance-f1-supplier-intake "Run the 07:00 check"
# Requires: the agent files copied to ~/.claude/agents and the finance-agents
# MCP server registered (see INSTALL.md). Output goes to logs/<agent>-<date>.log
set -euo pipefail
AGENT="${1:?agent name, e.g. finance-f1-supplier-intake}"
PROMPT="${2:-Run your scheduled routine now. Use only your MCP tools; post the run summary to the briefs channel.}"
mkdir -p logs
LOG="logs/${AGENT}-$(date -u +%Y%m%d-%H%M).log"
claude -p --agent "$AGENT" --permission-mode acceptEdits "$PROMPT" | tee "$LOG"

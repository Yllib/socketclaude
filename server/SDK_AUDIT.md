# Claude Agent SDK Audit — SocketClaude

*Audited against [official SDK docs](https://platform.claude.com/docs/en/agent-sdk/typescript), [changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). Installed version: 0.2.76. Date: 2026-03-17.*

## Status Legend
- [ ] Not started
- [x] Done
- [~] In progress

---

## Critical: Bugs / Incorrect Behavior

### 1. Token usage mismatch: per-turn tokens + total cost
- **Status:** [ ] Fix
- **File:** `claude-session.ts:1705-1726`
- **Issue:** `result` message sends last API turn's tokens (`lastTurnInputTokens`) alongside cumulative total cost (`result.total_cost_usd`). The SDK's `result.usage` (NonNullableUsage) has total tokens for the entire query. Should send both: totals for cost summary, per-turn for context fill bar.

### 2. `canUseTool` unreliable for plugins in bypass mode
- **Status:** [ ] Fix
- **File:** `claude-session.ts:674 + 751-888`
- **Issue:** In `bypassPermissions` mode, `canUseTool` is skipped for regular tools. Plugin `canUseToolInterceptor` runs in BOTH PreToolUse hook (line 674) AND `canUseTool` (line 756). For regular tools, only the hook fires. For AskUserQuestion, both fire (double execution). Remove plugin interceptors from `canUseTool`; keep only AskUserQuestion and ExitPlanMode there.

### 3. Assistant error check uses regex instead of enum
- **Status:** [ ] Fix
- **File:** `claude-session.ts:1295`
- **Issue:** `if (/auth/i.test(assistantError))` — SDK defines: `'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown'`. Use direct comparison.

### 4. Single global bash log file — concurrent collision
- **Status:** [ ] Fix
- **File:** `claude-session.ts:698-700`
- **Issue:** All bash commands tee to `/tmp/claude-bash-live.log`. Concurrent subagent bash commands overwrite each other.

### 5. `tool_summary` missing `parentToolUseId`
- **Status:** [ ] Fix
- **File:** `claude-session.ts:1210-1217`
- **Issue:** SDK's `SDKToolUseSummaryMessage` has `parent_tool_use_id` but it's not forwarded. Tool summaries inside subagents won't associate with correct hierarchy.

### 6. `streamInput` missing `priority` field
- **Status:** [ ] Fix
- **File:** `claude-session.ts:404-408`
- **Issue:** `SDKUserMessage` supports `priority?: 'now' | 'next' | 'later'`. Injected messages don't set it. Also `session_id` field is not part of SDKUserMessage and is ignored.

---

## SDK Messages NOT Handled

### 7. `rate_limit_event` — completely ignored
- **Status:** [ ] Fix
- **Issue:** SDK emits `SDKRateLimitEvent` with `status`, `resetsAt`, `utilization`, `rateLimitType`. No user visibility into rate limiting.

### 8. `system/task_started` — not handled
- **Status:** [ ] Fix
- **Issue:** SDK emits `SDKTaskStartedMessage` when background tasks launch (with `task_id`, `description`, `task_type`, `prompt`). Manually tracked via `_backgroundTaskToolUseIds` instead.

### 9. `system/task_progress` — not handled
- **Status:** [ ] Fix
- **Issue:** SDK emits `SDKTaskProgressMessage` periodically with `usage`, `last_tool_name`, `summary`. Never forwarded to app.

### 10. `system/api_retry` — not handled (new in v0.2.77)
- **Status:** [ ] Fix
- **Issue:** SDK emits retry messages with attempt count, max retries, delay, error status on transient API errors. Could show "retrying..." banner.

### 11. `system/local_command_output` — not handled
- **Status:** [ ] Fix
- **Issue:** Emitted when slash commands produce output. Silently dropped.

### 12. `prompt_suggestion` — not enabled
- **Status:** [ ] Fix
- **Issue:** Set `promptSuggestions: true` in options and SDK generates suggested next prompts after each turn. Could populate suggestion chips in app.

---

## SDK Features Not Used (Opportunities)

### 13. `maxTurns` / `maxBudgetUsd` — no guardrails
- **Status:** [ ] TODO
- **Issue:** Neither set. Runaway queries loop indefinitely or rack up unlimited cost.

### 14. `fallbackModel`
- **Status:** [ ] TODO
- **Issue:** No graceful degradation when primary model unavailable.

### 15. `agentProgressSummaries: true` — not enabled
- **Status:** [ ] Fix
- **Issue:** Added in v0.2.72. Makes background Agent tasks generate human-readable summaries in `task_progress` events. Currently not enabled.

### 16. `toolConfig.askUserQuestion.previewFormat`
- **Status:** [ ] Fix
- **Issue:** Added in v0.2.69. Setting `previewFormat: 'markdown'` adds `preview` field to question options. Could enhance QuestionCard UI.

### 17. SDK session management APIs
- **Status:** [ ] TODO
- **Issue:** `listSessions()`, `getSessionMessages()`, `renameSession()`, `tagSession()` available. Could replace custom JSONL parsing.

### 18. `supportedCommands()` and `supportedAgents()`
- **Status:** [ ] Fix
- **Issue:** `supportedModels()` used but not these. Could populate command palette or agent picker in app.

### 19. `accountInfo()`
- **Status:** [ ] TODO
- **Issue:** Never used. Could show account/org/subscription info.

### 20. `setPermissionMode()` on Query
- **Status:** [ ] TODO
- **Issue:** Could toggle to plan mode mid-session without new query.

### 21. `onElicitation` callback
- **Status:** [ ] TODO
- **Issue:** MCP server user input requests silently fail.

### 22. `sandbox` option
- **Status:** [ ] TODO
- **Issue:** Could restrict bash commands for safety.

### 23. `PostToolUse` hook
- **Status:** [ ] TODO
- **Issue:** Could enable post-tool auditing or output transformation.

### 24. `Notification` hook
- **Status:** [ ] TODO
- **Issue:** SDK fires notifications for permission_prompt, idle_prompt, auth_success, elicitation_dialog.

### 25. `SessionStart` / `SessionEnd` hooks
- **Status:** [ ] TODO
- **Issue:** Lifecycle events for metrics, cleanup, resource tracking.

### 26. `TaskCompleted` hook
- **Status:** [ ] TODO
- **Issue:** Fires when background tasks complete. Could trigger app notifications.

### 27. V2 API preview
- **Status:** [ ] TODO
- **Issue:** New `createSession()` + `send()`/`stream()` patterns. Worth evaluating.

---

## Unnecessary / Redundant Work

### 28. Double plugin interceptor execution (covered by #2)
- **Status:** [ ] Fix
- **File:** `claude-session.ts:674 + 751`
- **Issue:** Plugin `canUseToolInterceptor` called in both PreToolUse hook and canUseTool.

### 29. Double bash output streaming
- **Status:** [ ] TODO
- **File:** `claude-session.ts:697-708 + 739-749`
- **Issue:** Bash output streams via tee file watcher AND stderr callback. Overlap.

### 30. `_backgroundTaskToolUseIds` tracking redundant (covered by #8)
- **Status:** [ ] Fix
- **Issue:** Manual tracking replaceable by handling `task_started` events.

---

## Tracking / Data Issues

### 31. `result.usage` fields not fully forwarded (covered by #1)
- **Status:** [ ] Fix
- **Issue:** `webSearchRequests`, `maxOutputTokens`, `costUSD` not forwarded. `contextWindow` extracted indirectly.

### 32. `outputTokens` tracked but invisible
- **Status:** [ ] TODO
- **Issue:** App token bar only shows input segments. Users can't see generation cost.

### 33. Agent tool name: `Agent` vs `Task`
- **Status:** [x] OK
- **Issue:** SDK inconsistent. Dual check at line 1455 is correct.

### 34. `ExitPlanMode` — `planFilePath` available but unused
- **Status:** [ ] TODO
- **File:** `claude-session.ts:819-838`
- **Issue:** v0.2.76 added `planFilePath` to ExitPlanMode input. Code manually searches `~/.claude/plans/`.

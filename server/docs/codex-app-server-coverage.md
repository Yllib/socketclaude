# Codex app-server coverage

Last audited: 2026-08-24

Codex CLI/schema: `0.149.0`, checked with
`codex app-server generate-ts --out <directory>`

Primary reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server.md)

SocketAgent treats the app-server stream as two different surfaces:

1. User-visible turn work must be translated into a durable, tailored chat
   artifact.
2. Transport, cache invalidation, and lifecycle notifications should update
   state quietly. They remain available in raw SDK event history and must not
   create noisy chat cards.

## Turn item coverage

| App-server `ThreadItem` | SocketAgent presentation | Durable |
|---|---|---|
| `userMessage` | Native user message | Yes |
| `hookPrompt` | Hook Context card with fragments | Yes |
| `agentMessage` | Native streaming assistant message with commentary/final phase retained | Yes |
| `plan` | Native Codex plan card; final item is authoritative | Yes |
| `reasoning` | Thinking card with duration | Yes |
| `commandExecution` | Bash card with semantic action summary, cwd, command, streaming output, and exit state | Yes |
| `fileChange` | Apply Patch card with file list, unified diff, and line statistics | Yes |
| `mcpToolCall` | MCP/app card with app, action, arguments, progress, and result | Yes |
| `dynamicToolCall` | Namespaced Codex Tool card with structured arguments/results | Yes |
| `collabAgentToolCall` | Subagent lifecycle and hierarchy in transcript plus anchored task pane | Yes |
| `subAgentActivity` | Started, interacted, and interrupted lifecycle updates in the anchored task pane | Yes |
| `webSearch` | Web Search/Open Page/Find card with structured result rows | Yes |
| `imageView` | Image card with local preview/full-screen viewer | Yes |
| `sleep` | Interruptible wait card with duration | Yes |
| `imageGeneration` | Image Generation card with generated image preview | Yes |
| `enteredReviewMode` | Review Started card | Yes |
| `exitedReviewMode` | Review result card | Yes |
| `contextCompaction` | Compaction progress plus durable context boundary | Yes |

Unknown future item types are never silently discarded. They produce a
purpose-built **New Codex Item** diagnostic card with redacted payload data so
schema drift is visible without falling back to an unlabeled `Tool` card.

## User-visible notification and request coverage

| Family | Handling |
|---|---|
| Command/file/permission approval requests | Routed through SocketAgent policy and protected-file checks |
| `item/tool/requestUserInput` | Native question card; secret questions are rejected in favor of secure input |
| MCP elicitation | Native question or URL elicitation card |
| Safety buffering | Durable Safety Check card |
| Model verification | Durable Verification Required card |
| Automatic approval review | Durable Approval Review card |
| Model reroute | Durable Model Changed card with source, destination, and reason |
| Guardian, deprecation, configuration, and world-writable warnings | Explicit warning/error surface |
| Hook lifecycle | Active hook indicator; hook-supplied model context is retained as a Hook Context card |

## Quiet state/control notifications

The following are intentionally not chat cards:

- thread/turn start, completion, status, close, archive, delete, and name events;
- token usage and rate-limit cache updates;
- thread settings, which synchronize model, effort, collaboration mode, and
  cwd back to SocketAgent;
- server-request resolution acknowledgements, which also retire any pending
  question or elicitation card tied to the resolved request;
- moderation metadata, which is internal policy telemetry rather than
  user-facing content;
- filesystem watch, fuzzy-search, environment, marketplace, plugin, skills,
  OAuth, remote-control, realtime, and process-control notifications for APIs
  SocketAgent did not initiate.

All received app-server notifications are still recorded in the per-session
SDK event log for raw-mode inspection and future protocol audits.

## Audit procedure

For each managed Codex update:

1. Generate the TypeScript schema from the installed binary.
2. Diff the `ServerNotification`, `ServerRequest`, and `ThreadItem` unions
   against this matrix.
3. Count observed methods and item types in
   `~/.socket-agent/sdk-events/*.jsonl`.
4. Add explicit state handling or a tailored durable card before marking a new
   user-visible type covered.
5. Keep the unknown-item diagnostic path and its redaction test intact.

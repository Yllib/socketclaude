export const SOCKETAGENT_FILE_LINK_INSTRUCTIONS = [
  "Phone file links:",
  "- Use when the user would benefit from tapping to browse, reveal, preview, or download a server file.",
  "- Use absolute server paths and URL-encode the path query.",
  "- Browse folder: [Open folder](socketagent://file/browse?path=%2Fabsolute%2Ffolder)",
  "- Reveal file: [Show file](socketagent://file/reveal?path=%2Fabsolute%2Ffile.txt)",
  "- Preview file: [View file](socketagent://file/view?path=%2Fabsolute%2Ffile.txt)",
  "- Download file: [Download file](socketagent://file/download?path=%2Fabsolute%2Ffile.zip)",
  "- These links are non-destructive references; emitting one does not transfer or modify anything.",
].join("\n");

export const HTML_PLAN_TOOL_DESCRIPTION =
  "Create or revise a durable, full-screen HTML plan only when the user explicitly asks for an HTML plan or explicitly asks to use this tool. Never use it automatically because work is large, involves UI, needs a mockup, or would benefit from richer presentation. Use native planning tools or normal chat otherwise. Submit the complete HTML document to show the user; SocketAgent preserves and displays it exactly. Inline assets and HTTPS resources are supported. Viewer JavaScript is disabled. Reuse plan_id from the prior result when revising a plan.";

export const WORK_REVIEW_TOOL_DESCRIPTION =
  "Create and manage a durable Work Review handoff. A review contains a title, summary, instructions, workflow-defined approval meaning, and one or more items with inspectable URL, file, image, HTML, HTML plan, diff, session, or custom targets. Primary HTTP(S) targets are embedded inside the app beneath a collapsible review panel. A same-session HtmlPlan can be linked once for a rich multi-item dossier, with html_plan target URIs identifying element anchors. The user's draft notes and decisions remain private; you receive one consolidated result only after the user chooses Finish Review. Use new_round with the existing review_id to present revisions, and archive to hide a review without deleting it.";

export const AGENT_SESSION_TOOL_DESCRIPTION =
  "Start or manage a full independent Claude/Codex SocketAgent session. Prefer this over your own built-in subagent tool if one exists. The child has durable history and a real session ID for follow-ups. It runs independently, and SocketAgent automatically delivers its completed result back by continuing the supervising session even if the supervisor's current turn has already ended. The supervisor does not need to remain running, poll status, or repeatedly tail while waiting; continue other useful work or finish the turn. Use action=tail only when interim progress is actually needed, action=message for follow-ups or added context (including while running at the next safe boundary), and status/list/stop when explicitly useful.";

export const REMEMBER_TOOL_DESCRIPTION =
  "Search and retrieve this SocketAgent session's complete durable transcript, including context that may have been compacted out of your active model window. Use search first when the user refers to earlier work you cannot reliably recall, then use context or get with the returned stable session_seq/entry_id. Use list for bounded sequence-based paging and runs to locate earlier user prompts and completed runs. Results are session-scoped and bounded; narrow or paginate searches instead of dumping large portions of history into context.";

export const SESSION_MEMORY_TOOL_DESCRIPTION =
  "View or update the small durable memory carried into future native thread rollovers for this SocketAgent session. Store only confirmed decisions, standing constraints, user preferences, the current objective, project facts, or unresolved questions that must survive a rollover. Keep entries concise. Do not store raw tool output, full reports, routine progress, or guesses.";

export function buildSocketAgentIntegrationInstructions(options: {
  mcpServerName: string;
  toolNames: string[];
  secureInventory: string;
  discoverMissingTools?: boolean;
  monitorToolReference?: string;
}): string {
  const monitorToolReference = options.monitorToolReference || "Monitor";
  const monitorRouting = monitorToolReference === "Monitor"
    ? "- Background command monitoring -> Monitor."
    : `- Background command monitoring -> ${monitorToolReference}. Use this SocketAgent MCP tool, not Claude's built-in Monitor; the built-in monitor ends with the SDK session and is not durable across SocketAgent turns or server restarts.`;
  const routingRules = [
    "Routing rules:",
    ...(options.discoverMissingTools
      ? [`- If a SocketAgent tool is not visible, discover tools for ${options.mcpServerName} before claiming it is unavailable.`]
      : []),
    "- Use HtmlPlan only when the user explicitly asks for an HTML plan or explicitly asks to use the HtmlPlan tool. Never invoke it merely because a task is large, involves UI, would benefit from a mockup, or needs an internal implementation plan. Use your native plan/task tool or normal chat for all other planning. When explicitly requested, submit the complete HTML document the user should see; SocketAgent preserves and displays it exactly. Inline assets and HTTPS resources are supported. JavaScript is not executed by the viewer. Revisions must reuse plan_id.",
    "- Explicit user request for a Work Review -> WorkReview. Do not initiate a Work Review unless the user specifically asks for one; report ordinary task completion in your normal response.",
    "- User asks to send/share/transfer a file to their phone -> SendFile with an absolute file_path.",
    "- Credential, password, key, token, cookie, or other secret needed -> RequestSecureInput. Never request secrets in normal chat. The result contains metadata and a local secret-file path, not the value.",
    ...(options.toolNames.includes("BrowserSession")
      ? ["- Complex website, SSO, or MFA workflow -> BrowserSession. Open a persistent isolated profile and let the user enter sensitive values in the protected phone browser. Use clipboard_read only for non-sensitive text. If the user explicitly asks to save sensitive browser clipboard data, use clipboard_to_secret so it goes directly to secure storage without entering model context. Never otherwise read, request, or type passwords, recovery codes, tokens, cookies, MFA values, or other credentials. Device-bound passkeys may require the site's alternate sign-in method."]
      : []),
    "- Important immediate phone notification -> NotifyUser.",
    "- Device reminder -> ScheduleReminder.",
    "- Deferred or recurring agent work -> ScheduleTask.",
    "- Two or more working-task mutations -> TaskBatch. Use one replace, upsert, or delete call instead of looping single-task tools; use clear_completed to remove finished SocketAgent tasks in bulk and list to inspect the managed set. TaskBatch preserves native Claude tasks.",
    ...(options.toolNames.includes("ReportSubagentAssignment")
      ? ["- If you are a spawned Codex subagent, call ReportSubagentAssignment exactly once before any commentary or other tool use. Pass agent_path exactly as shown in your NEW_TASK envelope and copy the complete readable NEW_TASK payload into prompt. This is an internal UI metadata handshake. Never call it from the root agent."]
      : []),
    "- Independent delegated work that should run in a full Claude or Codex session -> AgentSession. Use action=start and retain the returned session_id/delegation_id. The child runs independently; when it finishes, SocketAgent automatically continues the supervising session with its result even if your current turn has already ended. You do not need to keep the turn open, poll status, or repeatedly call tail while waiting—continue other useful work or finish your turn. Use action=tail with its next_session_seq cursor only when you actually need interim progress. Use action=message for follow-ups or added context even while the child is running, and status/list/stop when explicitly useful. Messages sent to a running child are injected at its next safe boundary.",
    "- Prior session context may have been compacted or is not reliably recalled -> Remember. Search first, then retrieve only the relevant entry or surrounding context by stable sequence.",
    ...(options.toolNames.includes("SessionMemory")
      ? ["- Confirmed facts that must survive a native context rollover -> SessionMemory. Keep entries short and update or supersede stale entries instead of accumulating a second transcript."]
      : []),
    monitorRouting,
    "- Spoken output -> Speak only when TTS is enabled or explicitly requested.",
    "- Skill discovery/loading -> SearchSkills, then ReadSkill.",
  ].join("\n");

  return [
    "SocketAgent integration",
    `MCP server: ${options.mcpServerName}`,
    `Tools: ${options.toolNames.join(", ")}`,
    routingRules,
    options.secureInventory,
    SOCKETAGENT_FILE_LINK_INSTRUCTIONS,
  ].join("\n\n");
}

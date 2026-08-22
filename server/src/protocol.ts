// ── Backend selection ──

/**
 * Which agent backend drives the session. "claude" uses the Claude Agent SDK
 * (subscription auth via the Claude Code CLI). "codex" uses the OpenAI Codex
 * CLI (subscription auth via ChatGPT Plus/Pro). Defaults to "claude" when
 * omitted for backward compatibility with existing sessions.
 */
export type Backend = "claude" | "codex";

export type CodexDriver = "app-server";

// ── Transport capabilities ──

export const TRANSPORT_LANE_VERSION = 1;
export const UPLOAD_ACK_VERSION = 1;
export const WORK_REVIEW_VERSION = 2;
export const BULK_RELAY_PAIRING_SUFFIX = ":bulk:v1";
export type TransportLane = "control" | "bulk";

// ── Client → Server messages ──

export interface PromptMessage {
  type: "prompt";
  text: string;
  /** Stable client identity used for acknowledgement and idempotent retry. */
  messageId?: string;
  priority?: string;
  sessionId?: string;
  cwd?: string;
  backend?: Backend;
  codexFastMode?: boolean;
  /**
   * Settings selected while composing a brand-new session. The server applies
   * these immediately before the first turn so the first prompt cannot race
   * separate setting messages.
   */
  initialSettings?: InitialSessionSettings;
}

export interface PromptReceivedServerMessage {
  type: "prompt_received";
  messageId: string;
  sessionId?: string;
  duplicate?: boolean;
}

export interface PromptFailedServerMessage {
  type: "prompt_failed";
  messageId: string;
  sessionId?: string;
  message: string;
}

export type CodexGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface CodexGoal {
  threadId: string;
  objective: string;
  status: CodexGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexGoalGetMessage {
  type: "codex_goal_get";
  requestId: string;
  sessionId: string;
}

export interface CodexGoalSetMessage {
  type: "codex_goal_set";
  requestId: string;
  sessionId: string;
  objective?: string;
  status?: CodexGoalStatus;
  tokenBudget?: number | null;
}

export interface CodexGoalClearMessage {
  type: "codex_goal_clear";
  requestId: string;
  sessionId: string;
}

export interface RetractQueuedPromptMessage {
  type: "retract_queued_prompt";
  messageId: string;
}

export interface AnswerMessage {
  type: "answer";
  questionId: string;
  answers: Record<string, string>;
  sessionId?: string;
}

export interface PrivateIntegrationAuthRequestMessage {
  type: "private_integration_auth_request";
  requestId: string;
  integration: "outlook-auth" | "ibs-auth";
}

export interface SecureInputResponseMessage {
  type: "secure_input_response";
  requestId: string;
  value?: string;
  secretId?: string;
  sessionId?: string;
  cancelled?: boolean;
}

export interface SecureInputStoreMessage {
  type: "secure_input_store";
  label: string;
  value: string;
  reason?: string;
  envHint?: string;
  scope?: "session" | "project" | "global";
  sessionId?: string;
  cwd?: string;
  clientRequestId?: string;
}

export interface SecretInventoryRequestMessage {
  type: "secret_inventory_request";
  requestId?: string;
  sessionId?: string;
  cwd?: string;
}

export interface SecretReplaceMessage {
  type: "secret_replace";
  requestId: string;
  secretId: string;
  value: string;
  label?: string;
  envHint?: string;
  sessionId?: string;
  cwd?: string;
}

export interface SecretDeleteMessage {
  type: "secret_delete";
  requestId: string;
  secretId: string;
  sessionId?: string;
  cwd?: string;
}

export interface HtmlPlanListMessage {
  type: "html_plan_list";
  requestId?: string;
  sessionId: string;
}

export interface HtmlPlanRenameMessage {
  type: "html_plan_rename";
  requestId: string;
  sessionId: string;
  planId: string;
  title: string;
}

export interface HtmlPlanDeleteMessage {
  type: "html_plan_delete";
  requestId: string;
  sessionId: string;
  planId: string;
}

export interface HtmlPlanRevisionListMessage {
  type: "html_plan_revision_list";
  requestId: string;
  sessionId: string;
  planId: string;
}

export interface HtmlPlanRevisionGetMessage {
  type: "html_plan_revision_get";
  requestId: string;
  sessionId: string;
  planId: string;
  revision: number;
  baseRevision?: number;
}

export interface HtmlPlanRollbackMessage {
  type: "html_plan_rollback";
  requestId: string;
  sessionId: string;
  planId: string;
  revision: number;
}

export type WorkReviewDisposition =
  | "approved"
  | "changes_requested"
  | "rejected"
  | "skipped";

export interface WorkReviewDraftItem {
  itemId: string;
  status: "pending" | WorkReviewDisposition;
  note?: string;
}

/**
 * Mutable, reviewer-private state. This object is returned only to app
 * clients; agent-facing WorkReview reads intentionally omit it until finish.
 */
export interface WorkReviewDraft {
  revision?: number;
  updatedAt?: string;
  overallNote?: string;
  items: WorkReviewDraftItem[];
}

export interface WorkReviewListMessage {
  type: "work_review_list";
  requestId?: string;
  sessionId?: string;
  includeArchived?: boolean;
}

export interface WorkReviewGetMessage {
  type: "work_review_get";
  requestId: string;
  reviewId: string;
}

export interface WorkReviewDraftUpdateMessage {
  type: "work_review_draft_update";
  requestId: string;
  reviewId: string;
  roundId: string;
  /** Stable client-generated id used to deduplicate retries. */
  mutationId: string;
  /** Optional optimistic-concurrency cursor from the latest draft snapshot. */
  baseRevision?: number;
  /** Full private snapshot, never an incremental feedback event. */
  draft: WorkReviewDraft;
}

export interface WorkReviewFinishMessage {
  type: "work_review_finish";
  requestId: string;
  reviewId: string;
  roundId: string;
  /** Stable client-generated id used to make Finish Review idempotent. */
  mutationId: string;
  baseRevision?: number;
  /** The complete final draft is published atomically by this operation. */
  draft: WorkReviewDraft;
}

export interface WorkReviewCancelMessage {
  type: "work_review_cancel";
  requestId: string;
  reviewId: string;
  roundId: string;
}

export interface WorkReviewArchiveMessage {
  type: "work_review_archive";
  requestId: string;
  reviewId: string;
}

export interface WorkReviewRestoreMessage {
  type: "work_review_restore";
  requestId: string;
  reviewId: string;
}

export interface NewSessionMessage {
  type: "new_session";
  cwd?: string;
  /** Which agent backend to use. Defaults to "claude" if omitted. */
  backend?: Backend;
}

export interface ResumeSessionMessage {
  type: "resume_session";
  sessionId: string;
  /** Correlates the initial history snapshot with the view that requested it. */
  historyRequestId?: string;
  /** Last durable transcript position already cached by this client. */
  knownSessionSeq?: number;
  /** Oldest history offset represented by the client's cached snapshot. */
  knownHistoryOffset?: number;
  /** Number of contiguous durable entries represented by the cached snapshot. */
  knownHistoryEntryCount?: number;
  /** Optional client trace identifier for click-to-ready diagnostics. */
  openTraceId?: string;
}

export interface SessionEventAckMessage {
  type: "session_event_ack";
  sessionId: string;
  deliveryId: string;
}

export interface ClientEventErrorMessage {
  type: "client_event_error";
  sessionId?: string;
  eventType?: string;
  deliveryId?: string;
  toolUseId?: string;
  message: string;
}

export interface ListSessionsMessage {
  type: "list_sessions";
}

export interface GetServerSettingsMessage {
  type: "get_server_settings";
}

export interface SetCodexDriverMessage {
  type: "set_codex_driver";
  driver: CodexDriver;
}

export interface SetServerSettingsMessage {
  type: "set_server_settings";
  defaultCwd?: string;
  systemPrompt?: string;
  /**
   * Server-wide Claude auto-compaction window in tokens. SocketAgent defaults
   * an absent setting to 250,000. Null explicitly restores the SDK/model
   * default.
   */
  claudeAutoCompactWindow?: number | null;
  /** Migration helper: seed the server only when it has no prompt yet. */
  systemPromptIfUnset?: string;
}

export interface BackendInstallMessage {
  type: "backend_install";
  backend: Backend;
  reinstall?: boolean;
  authenticate?: boolean;
  forceAuthenticate?: boolean;
  operation?: "repair" | "auth";
  requestId?: string;
}

export interface BackendInstallCancelMessage {
  type: "backend_install_cancel";
  backend: Backend;
  requestId?: string;
}

export interface DeleteSessionMessage {
  type: "delete_session";
  sessionId: string;
}

export interface RenameSessionMessage {
  type: "rename_session";
  sessionId: string;
  title: string;
}

export interface AbortMessage {
  type: "abort";
  sessionId?: string;
  /** Stable id reused until the client receives abort_ack. */
  requestId?: string;
}

export interface InterruptMessage {
  type: "interrupt";
}

export interface SetTtsMessage {
  type: "set_tts";
  enabled: boolean;
}

export interface SetTtsEngineMessage {
  type: "set_tts_engine";
  engine: "system" | "kokoro_server" | "kokoro_device";
  voice?: string;
  speed?: number;
}

export interface RequestTtsAudioMessage {
  type: "request_tts_audio";
  text: string;
  voice?: string;
  speed?: number;
}

export interface RequestFileMessage {
  type: "request_file";
  filePath: string;
  fileId?: string;
  offsetBytes?: number;
  transferToken?: string;
  expectedFileVersion?: string;
}

export interface LoadMoreHistoryMessage {
  type: "load_more_history";
  sessionId: string;
  offset: number;
  limit: number;
  /** Correlates an older-history page with the pagination request. */
  requestId?: string;
}

export interface CheckCwdMessage {
  type: "check_cwd";
  path: string;
  requestId?: string;
}

export interface CreateCwdMessage {
  type: "create_cwd";
  path: string;
  requestId?: string;
}

export interface FileManagerListMessage {
  type: "file_manager_list";
  requestId?: string;
  path?: string;
  includeHidden?: boolean;
  offset?: number;
  limit?: number;
  anchorPath?: string;
}

export interface FileManagerStatMessage {
  type: "file_manager_stat";
  requestId?: string;
  path: string;
}

export interface MacosPermissionStatusMessage {
  type: "macos_permission_status";
  requestId?: string;
  path?: string;
}

export interface MacosPermissionActionMessage {
  type: "macos_permission_action";
  requestId?: string;
  action: "open_settings" | "reveal_helper" | "restart";
}

export interface FileManagerSetProtectedMessage {
  type: "file_manager_set_protected";
  requestId?: string;
  path: string;
  protected: boolean;
  label?: string;
  pattern?: "exact" | "directory";
}

export interface FileManagerDownloadMessage {
  type: "file_manager_download";
  requestId?: string;
  path: string;
  fileId?: string;
  offsetBytes?: number;
  transferToken?: string;
  expectedFileVersion?: string;
}

export interface FileManagerReadTextMessage {
  type: "file_manager_read_text";
  requestId?: string;
  path: string;
  maxBytes?: number;
}

export interface FileManagerWriteTextMessage {
  type: "file_manager_write_text";
  requestId?: string;
  path: string;
  content: string;
}

export interface FileManagerMkdirMessage {
  type: "file_manager_mkdir";
  requestId?: string;
  path: string;
}

export interface FileManagerRenameMessage {
  type: "file_manager_rename";
  requestId?: string;
  fromPath: string;
  toName: string;
}

export interface FileManagerDeleteMessage {
  type: "file_manager_delete";
  requestId?: string;
  path: string;
  recursive?: boolean;
}

export interface FileManagerUploadStartMessage {
  type: "file_manager_upload_start";
  requestId?: string;
  uploadId: string;
  targetDir: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunkSize: number;
  conflictPolicy?: "fail" | "rename" | "overwrite";
}

export interface ClearContextMessage {
  type: "clear_context";
  sessionId: string;
}

export interface CompactContextMessage {
  type: "compact_context";
  sessionId?: string;
}

export interface CodexRollbackThreadMessage {
  type: "codex_rollback_thread";
  sessionId?: string;
  numTurns: number;
}

export interface CodexCollaborationModesMessage {
  type: "codex_collaboration_modes";
}

export interface SetCodexCollaborationModeMessage {
  type: "set_codex_collaboration_mode";
  mode: string;
}

export interface ArchiveSessionMessage {
  type: "archive_session";
  sessionId: string;
}

export interface SessionTransferExportMessage {
  type: "session_transfer_export";
  requestId: string;
  sessionId: string;
}

export interface SessionTransferImportMessage {
  type: "session_transfer_import";
  requestId: string;
  bundlePath: string;
  expectedSha256: string;
  targetCwd: string;
  targetBackend: Backend;
  mode: "move" | "clone";
  nativeMode: "exact" | "handoff";
}

export interface SessionTransferDiscardMessage {
  type: "session_transfer_discard";
  requestId: string;
  bundlePath: string;
}

export interface ListArchivesMessage {
  type: "list_archives";
}

export interface GetArchiveHistoryMessage {
  type: "get_archive_history";
  sid: string;
  ts: string;
}

export interface RestoreArchiveMessage {
  type: "restore_archive";
  sid: string;
  ts: string;
}

export interface DeleteArchiveMessage {
  type: "delete_archive";
  sid: string;
  ts: string;
}

export interface UploadStartMessage {
  type: "upload_start";
  uploadId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunkSize?: number;
  sessionId?: string;
  cwd?: string;
}

export interface UploadChunkMessage {
  type: "upload_chunk";
  uploadId: string;
  chunkIndex: number;
  data: string;
}

/** Binary-frame variant of upload_chunk — `data` is raw bytes, no base64 inflation. */
export interface UploadChunkBinMessage {
  type: "upload_chunk_bin";
  uploadId: string;
  chunkIndex: number;
  data: Buffer;
}

/** Phone announces its wire-format support after key exchange. */
export interface ClientCapabilitiesMessage {
  type: "client_capabilities";
  lane?: TransportLane;
  transportLaneVersion?: number;
  uploadAckVersion?: number;
  binaryEnvelope?: boolean;
  binaryFileDownloadVersion?: number;
  /**
   * Version 1 means the client acknowledges only after its live reducer has
   * applied a tracked session event. Do not infer this from the legacy boolean:
   * app v1.0.114 advertised that flag before it implemented acknowledgements.
   */
  sessionEventAckVersion?: number;
  /** @deprecated Ambiguous compatibility flag; never enables tracked delivery. */
  sessionEventAck?: boolean;
}

export interface SetRawModeMessage {
  type: "set_raw_mode";
  enabled: boolean;
  sessionId?: string;
}

/** Direct E2E auth token proof, sent only after the NaCl key exchange. */
export interface DirectAuthMessage {
  type: "direct_auth";
  token: string;
  lane?: TransportLane;
  transportLaneVersion?: number;
  uploadAckVersion?: number;
  binaryEnvelope?: boolean;
  binaryFileDownloadVersion?: number;
  sessionEventAckVersion?: number;
  /** @deprecated Ambiguous compatibility flag; never enables tracked delivery. */
  sessionEventAck?: boolean;
}

export const SESSION_EVENT_ACK_VERSION = 1;
export const MONITOR_OUTPUT_ACK_VERSION = 2;

export function supportsSessionEventAcknowledgement(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const version = (message as Record<string, unknown>).sessionEventAckVersion;
  return typeof version === "number"
    && Number.isInteger(version)
    && version >= SESSION_EVENT_ACK_VERSION;
}

export function supportsMonitorOutputAcknowledgement(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const version = (message as Record<string, unknown>).sessionEventAckVersion;
  return typeof version === "number"
    && Number.isInteger(version)
    && version >= MONITOR_OUTPUT_ACK_VERSION;
}

export interface FileDownloadAckMessage {
  type: "file_download_ack";
  fileId: string;
  transferToken?: string;
  receivedBytes: number;
}

export interface TerminalAttachMessage {
  type: "terminal_attach";
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalInputMessage {
  type: "terminal_input";
  data: string;
}

export interface TerminalResizeMessage {
  type: "terminal_resize";
  cols: number;
  rows: number;
}

export interface TerminalDetachMessage {
  type: "terminal_detach";
}

export interface TerminalKillMessage {
  type: "terminal_kill";
}

export interface AdbBridgeSidecarStartMessage {
  type: "adb_bridge_sidecar_start";
  requestId?: string;
  localPort?: number;
}

export interface AdbBridgeSidecarStopMessage {
  type: "adb_bridge_sidecar_stop";
  requestId?: string;
}

export interface AdbBridgeSidecarStatusMessage {
  type: "adb_bridge_sidecar_status";
  requestId?: string;
}

export interface AdbCommandMessage {
  type: "adb_command";
  requestId?: string;
  command: "pair" | "connect";
  host: string;
  port: number;
  code?: string;
}

export interface PhoneAdbResultMessage {
  type: "phone_adb_result";
  requestId: string;
  result: Record<string, unknown>;
}

export interface PhoneAdbStreamChunkMessage {
  type: "phone_adb_stream_chunk";
  requestId: string;
  stream: "stdout" | "stderr" | string;
  data: string;
}

export interface RegisterPushTokenMessage {
  type: "register_push_token";
  fcmToken: string;
  platform?: string;
  appServerId?: string;
}

export interface UnregisterPushTokenMessage {
  type: "unregister_push_token";
  fcmToken: string;
  appServerId?: string;
}

export interface GetPushRegistrationMessage {
  type: "get_push_registration";
  fcmToken: string;
  appServerId?: string;
}

export interface SetEffortMessage {
  type: "set_effort";
  effort: "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | "ultra";
}

export interface SetCodexFastModeMessage {
  type: "set_codex_fast_mode";
  enabled: boolean;
}

export interface SetClaudeAutoCompactMessage {
  type: "set_claude_auto_compact";
  enabled: boolean;
}

export interface SetClaudeAutoCompactWindowMessage {
  type: "set_claude_auto_compact_window";
  /** Per-session override in tokens. Omit when clearing the override. */
  window?: number;
  /** Remove the session override and inherit the server setting. */
  clearOverride?: boolean;
}

export interface SetThinkingMessage {
  type: "set_thinking";
  thinking:
    | { type: "adaptive" }
    | { type: "enabled"; budgetTokens: number }
    | { type: "disabled" };
}

export interface SetDisallowedToolsMessage {
  type: "set_disallowed_tools";
  tools: string[];
  sessionId?: string;
}

export interface SetSystemPromptMessage {
  type: "set_system_prompt";
  prompt: string;
  sessionId?: string;
  /** Apply the server default without storing it as a session override. */
  inherited?: boolean;
  /** Remove a previously persisted session override. */
  clearOverride?: boolean;
}

export type AgentEffort = "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | "ultra";

export type AgentThinkingSetting =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" };

export interface AgentSessionSettings {
  model?: string;
  effort?: AgentEffort;
  thinking?: AgentThinkingSetting;
  codexFastMode?: boolean;
  codexCollaborationMode?: string;
  claudeAutoCompact?: boolean;
  /** Per-session override; absent means inherit the server setting. */
  claudeAutoCompactWindow?: number;
  disallowedTools?: string[];
  systemPrompt?: string;
  /** Connected apps the user approved for the lifetime of this session. */
  connectedAppApprovals?: string[];
}

export interface InitialSessionSettings extends AgentSessionSettings {
  permissionMode?: string;
}

export interface StopTaskMessage {
  type: "stop_task";
  taskId: string;
}

export interface StopMonitorMessage {
  type: "stop_monitor";
  taskId: string;
}

export interface ForkSessionMessage {
  type: "fork_session";
  sessionId: string;
}

export interface SetModelMessage {
  type: "set_model";
  model?: string;
}

export interface SetPermissionModeMessage {
  type: "set_permission_mode";
  mode: string;
}

export interface McpStatusRequestMessage {
  type: "mcp_status";
}

export interface GetContextUsageMessage {
  type: "get_context_usage";
}

export interface GetSdkEventHistoryMessage {
  type: "get_sdk_event_history";
  sessionId?: string;
  limit?: number;
}

export interface McpReconnectMessage {
  type: "mcp_reconnect";
  serverName: string;
}

export interface McpToggleMessage {
  type: "mcp_toggle";
  serverName: string;
  enabled: boolean;
}

export interface RewindMessage {
  type: "rewind";
  userMessageUuid: string;
  dryRun?: boolean;
}

export interface RewindConversationMessage {
  type: "rewind_conversation";
  userMessageUuid: string;
  dryRun?: boolean;
  rewindFiles?: boolean; // default true — set false to rewind conversation only, leaving files as-is
}

export interface BranchFromMessage {
  type: "branch_from_message";
  sessionId: string;
  userMessageUuid: string;
}

export interface SyncDesktopMessage {
  type: "sync_desktop";
  sessionId: string;
}

export interface ListSdkSessionsMessage {
  type: "list_sdk_sessions";
  /** Exact folder to inspect. Omit with all=true for machine-wide search. */
  cwd?: string;
  /** Include sessions whose working directory is below cwd. */
  recursive?: boolean;
  /** Search title, prompt preview, cwd, and backend. */
  query?: string;
  /** Search all indexed native and tracked sessions on this computer. */
  all?: boolean;
  requestId?: string;
  limit?: number;
}

export interface ScheduleTaskMessage {
  type: "schedule_task";
  name?: string;
  prompt: string;
  cwd: string;
  backend?: Backend;
  codexDriver?: CodexDriver;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: string;
  scheduledTime: string;
  recurrence?: {
    type: "once" | "daily" | "weekly" | "monthly" | "custom";
    intervalMs?: number;
  };
  /** Carry summaries from the two most recent runs into a fresh session. */
  reuseSession?: boolean;
  notificationMode?: "completion" | "quiet";
}

export interface ListScheduledTasksMessage {
  type: "list_scheduled_tasks";
}

export interface CancelScheduledTaskMessage {
  type: "cancel_scheduled_task";
  taskId: string;
}

export interface ExecuteScheduledTaskMessage {
  type: "execute_scheduled_task";
  taskId: string;
}

export interface UpdateScheduledTaskMessage {
  type: "update_scheduled_task";
  taskId: string;
  name?: string;
  prompt?: string;
  cwd?: string;
  backend?: Backend;
  codexDriver?: CodexDriver | null;
  model?: string | null;
  effort?: AgentEffort;
  permissionMode?: string;
  scheduledTime?: string;
  recurrence?: { type: "once" | "daily" | "weekly" | "monthly" | "custom"; intervalMs?: number } | null;
  /** Carry summaries from the two most recent runs into a fresh session. */
  reuseSession?: boolean;
  notificationMode?: "completion" | "quiet";
}

export interface DeleteScheduledTaskMessage {
  type: "delete_scheduled_task";
  taskId: string;
}

export interface MarkScheduledTaskReadMessage {
  type: "mark_scheduled_task_read";
  taskId: string;
  read: boolean;
}

export interface ArchiveScheduledTaskMessage {
  type: "archive_scheduled_task";
  taskId: string;
}

export interface RestoreScheduledTaskMessage {
  type: "restore_scheduled_task";
  taskId: string;
}

export type ClientMessage =
  | PromptMessage
  | RetractQueuedPromptMessage
  | AnswerMessage
  | PrivateIntegrationAuthRequestMessage
  | SecureInputResponseMessage
  | SecureInputStoreMessage
  | SecretInventoryRequestMessage
  | SecretReplaceMessage
  | SecretDeleteMessage
  | HtmlPlanListMessage
  | HtmlPlanRenameMessage
  | HtmlPlanDeleteMessage
  | HtmlPlanRevisionListMessage
  | HtmlPlanRevisionGetMessage
  | HtmlPlanRollbackMessage
  | WorkReviewListMessage
  | WorkReviewGetMessage
  | WorkReviewDraftUpdateMessage
  | WorkReviewFinishMessage
  | WorkReviewCancelMessage
  | WorkReviewArchiveMessage
  | WorkReviewRestoreMessage
  | NewSessionMessage
  | ResumeSessionMessage
  | SessionEventAckMessage
  | ClientEventErrorMessage
  | ListSessionsMessage
  | GetServerSettingsMessage
  | SetCodexDriverMessage
  | SetServerSettingsMessage
  | BackendInstallMessage
  | BackendInstallCancelMessage
  | CodexCollaborationModesMessage
  | SetCodexCollaborationModeMessage
  | DeleteSessionMessage
  | RenameSessionMessage
  | ClearContextMessage
  | CompactContextMessage
  | CodexRollbackThreadMessage
  | ArchiveSessionMessage
  | SessionTransferExportMessage
  | SessionTransferImportMessage
  | SessionTransferDiscardMessage
  | AbortMessage
  | InterruptMessage
  | SetTtsMessage
  | SetTtsEngineMessage
  | RequestTtsAudioMessage
  | SetEffortMessage
  | SetCodexFastModeMessage
  | SetClaudeAutoCompactMessage
  | SetClaudeAutoCompactWindowMessage
  | SetThinkingMessage
  | SetDisallowedToolsMessage
  | SetSystemPromptMessage
  | StopTaskMessage
  | StopMonitorMessage
  | ForkSessionMessage
  | SetModelMessage
  | SetPermissionModeMessage
  | McpStatusRequestMessage
  | GetContextUsageMessage
  | GetSdkEventHistoryMessage
  | McpReconnectMessage
  | McpToggleMessage
  | RewindMessage
  | RewindConversationMessage
  | BranchFromMessage
  | SyncDesktopMessage
  | ListSdkSessionsMessage
  | RequestFileMessage
  | LoadMoreHistoryMessage
  | CheckCwdMessage
  | CreateCwdMessage
  | FileManagerListMessage
  | FileManagerStatMessage
  | MacosPermissionStatusMessage
  | MacosPermissionActionMessage
  | FileManagerSetProtectedMessage
  | FileManagerDownloadMessage
  | FileManagerReadTextMessage
  | FileManagerWriteTextMessage
  | FileManagerMkdirMessage
  | FileManagerRenameMessage
  | FileManagerDeleteMessage
  | FileManagerUploadStartMessage
  | UploadStartMessage
  | UploadChunkMessage
  | UploadChunkBinMessage
  | FileDownloadAckMessage
  | ClientCapabilitiesMessage
  | SetRawModeMessage
  | DirectAuthMessage
  | TerminalAttachMessage
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalDetachMessage
  | TerminalKillMessage
  | AdbBridgeSidecarStartMessage
  | AdbBridgeSidecarStopMessage
  | AdbBridgeSidecarStatusMessage
  | AdbCommandMessage
  | PhoneAdbResultMessage
  | PhoneAdbStreamChunkMessage
  | RegisterPushTokenMessage
  | UnregisterPushTokenMessage
  | GetPushRegistrationMessage
  | ScheduleTaskMessage
  | ListScheduledTasksMessage
  | CancelScheduledTaskMessage
  | ExecuteScheduledTaskMessage
  | UpdateScheduledTaskMessage
  | DeleteScheduledTaskMessage
  | MarkScheduledTaskReadMessage
  | ArchiveScheduledTaskMessage
  | RestoreScheduledTaskMessage
  | ListArchivesMessage
  | GetArchiveHistoryMessage
  | RestoreArchiveMessage
  | DeleteArchiveMessage
  | { type: "auth_code"; code: string; sessionId?: string; authRequestId?: string }
  | { type: "version_check" }
  | { type: "force_update" }
  | { type: "get_status_sync" }
  | { type: "get_codex_status" }
  | { type: "get_recent_cwds" }
  | { type: "add_recent_cwd"; cwd: string }
  | { type: "remove_recent_cwd"; cwd: string }
  | { type: "skills_list" }
  | { type: "codex_slash_command"; name: string; args?: string; sessionId?: string }
  | CodexGoalGetMessage
  | CodexGoalSetMessage
  | CodexGoalClearMessage
  | { type: "skills_save"; name: string; scope: string; format: string; agent?: "claude" | "codex"; frontmatter: Record<string, string>; body: string; filePath?: string }
  | { type: "skills_delete"; filePath: string }
  | { type: "protected_files_list"; requestId?: string }
  | { type: "protected_files_add"; requestId?: string; path: string; label?: string }
  | { type: "protected_files_delete"; requestId?: string; path: string }
  | { type: "plugins_list" }
  | { type: "plugins_install"; pluginId: string }
  | { type: "plugins_uninstall"; pluginId: string }
  | { type: "plugins_enable"; pluginId: string }
  | { type: "plugins_disable"; pluginId: string }
  | { type: "marketplaces_list" }
  | { type: "marketplaces_add"; url: string }
  | { type: "marketplaces_update"; name: string }
  | { type: "marketplaces_remove"; name: string };

// ── Server → Client messages ──

export interface TextServerMessage {
  type: "text";
  content: string;
  sessionId: string;
  streamId?: string;
  parentToolUseId?: string | null;
  uuid?: string;
  replay?: boolean;
  snapshot?: boolean;
  finalSnapshot?: boolean;
  deliveryId?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface ToolCallServerMessage {
  type: "tool_call";
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
  parentToolUseId?: string | null;
  uuid?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface ToolResultServerMessage {
  type: "tool_result";
  toolUseId: string;
  output: string;
  sessionId: string;
  /** The Agent tool returned its non-terminal async launch acknowledgement. */
  backgroundPending?: boolean;
  parentToolUseId?: string | null;
  uuid?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface ToolImageServerMessage {
  type: "tool_image";
  toolUseId: string;
  imageData: string;
  mimeType: string;
  filePath: string;
  sessionId: string;
  parentToolUseId?: string | null;
}

export interface EmailPreview {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  attachment?: string;
  scheduledTime?: string;
}

export interface QuestionServerMessage {
  type: "question";
  questionId: string;
  questions: QuestionItem[];
  sessionId: string;
  emailPreview?: EmailPreview;
  mcpServerName?: string;
}

export interface QuestionAnsweredServerMessage {
  type: "question_answered";
  questionId: string;
  sessionId?: string;
  /** Safe, user-visible answers. Secure-input values never use this message. */
  answers?: Record<string, string>;
}

export interface SecureInputRequestServerMessage {
  type: "secure_input_request";
  requestId: string;
  sessionId: string;
  label: string;
  reason?: string;
  envHint?: string;
  scope?: "session" | "project" | "global";
  multiline?: boolean;
}

export interface SecureInputSavedServerMessage {
  type: "secure_input_saved";
  requestId?: string;
  sessionId?: string;
  secretId: string;
  label: string;
  scope: "session" | "project" | "global";
  filePath: string;
  envHint: string;
  clientRequestId?: string;
}

export interface SecretInventoryEntry {
  secretId: string;
  label: string;
  scope: "session" | "project" | "global";
  filePath: string;
  envHint: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SecretInventoryServerMessage {
  type: "secret_inventory";
  requestId?: string;
  sessionId?: string;
  secrets: SecretInventoryEntry[];
}

export interface SecretOperationResultServerMessage {
  type: "secret_operation_result";
  requestId: string;
  operation: "create" | "replace" | "delete";
  ok: boolean;
  error?: string;
  secret?: SecretInventoryEntry;
}

export interface HtmlPlanRecord {
  planId: string;
  sessionId: string;
  title: string;
  html: string;
  createdAt: string;
  updatedAt: string;
  currentRevision: number;
  revisionCount: number;
}

export interface HtmlPlanRevisionSummaryRecord {
  revision: number;
  title: string;
  createdAt: string;
  byteSize: number;
  restoredFromRevision?: number;
}

export interface HtmlPlanRevisionRecord {
  revision: number;
  title: string;
  html: string;
  createdAt: string;
  restoredFromRevision?: number;
}

export interface HtmlPlanDiffSegmentRecord {
  type: "equal" | "added" | "removed";
  text: string;
}

export interface HtmlPlanServerMessage extends HtmlPlanRecord {
  type: "html_plan";
  deliveryId?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface HtmlPlanListServerMessage {
  type: "html_plan_list";
  requestId?: string;
  sessionId: string;
  plans: HtmlPlanRecord[];
}

export interface HtmlPlanOperationResultServerMessage {
  type: "html_plan_operation_result";
  requestId: string;
  operation: "rename" | "delete" | "rollback";
  ok: boolean;
  sessionId: string;
  planId: string;
  error?: string;
  plan?: HtmlPlanRecord;
}

export interface HtmlPlanRevisionListServerMessage {
  type: "html_plan_revision_list";
  requestId: string;
  sessionId: string;
  planId: string;
  ok: boolean;
  error?: string;
  revisions: HtmlPlanRevisionSummaryRecord[];
}

export interface HtmlPlanRevisionServerMessage {
  type: "html_plan_revision";
  requestId: string;
  sessionId: string;
  planId: string;
  ok: boolean;
  error?: string;
  revision?: HtmlPlanRevisionRecord;
  baseRevision?: number;
  diff: HtmlPlanDiffSegmentRecord[];
}

export interface QuestionItem {
  question: string;
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}

export interface ThinkingServerMessage {
  type: "thinking";
  content: string;
  sessionId: string;
  /** Final estimated reasoning tokens when the backend provides them. */
  thinkingTokens?: number;
  /** Wall-clock duration of this reasoning block. */
  thinkingDurationMs?: number;
  /** Start time used for durable ordering and elapsed-time display. */
  timestamp?: string;
  streamId?: string;
  parentToolUseId?: string | null;
  uuid?: string;
  replay?: boolean;
  snapshot?: boolean;
  finalSnapshot?: boolean;
  deliveryId?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

/**
 * Live thinking progress. When extended thinking is redacted the API streams
 * pings instead of text, so `thinking` messages never arrive and this running
 * token estimate is the only sign that reasoning is happening. Progress frames
 * are transient; the completed reasoning lifecycle is persisted as a Thinking
 * history entry even when its text is withheld.
 */
export interface ThinkingTokensServerMessage {
  type: "thinking_tokens";
  estimatedTokens: number;
  estimatedTokensDelta: number;
  sessionId: string;
  uuid?: string;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  contextWindow: number;
}

export interface TotalUsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
}

export interface ResultServerMessage {
  type: "result";
  content: string;
  sessionId: string;
  /** More user context was queued and this SDK stream is continuing. */
  continuationPending?: boolean;
  costUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  usage?: UsageInfo;
  totalUsage?: TotalUsageInfo;
  numTurns?: number;
  stopReason?: string;
  resultSubtype?: string;
  terminalReason?: string;
  fastModeState?: string;
  errors?: string[];
  permissionDenials?: { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }[];
}

export interface SessionListServerMessage {
  type: "session_list";
  sessions: SessionInfo[];
}

export interface SdkSessionListServerMessage {
  type: "sdk_session_list";
  cwd: string;
  recursive?: boolean;
  query?: string;
  all?: boolean;
  requestId?: string;
  total: number;
  hasMore: boolean;
  sessions: Array<{
    sessionId: string;
    firstMessage: string;
    cwd?: string;
    tracked?: boolean;
    title?: string;
    lastActive: string;
    backend?: Backend;
  }>;
}

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  lastActive: string;
  messagePreview: string;
  /** Number of user turns/prompts in this session when known. */
  turnCount?: number;
  /** Number of SocketAgent history entries when known. */
  historyCount?: number;
  running?: boolean;
  /** Server-owned ISO timestamp for the current active turn/compaction. */
  activeStartedAt?: string;
  /** Durable user-visible logical-run statistics for this session. */
  runStats?: SessionRunStats;
  lastUsage?: UsageInfo & { costUsd?: number; numTurns?: number };
  scheduledTaskId?: string;
  /** Backend that drives this session. Absent on legacy sessions = "claude". */
  backend?: Backend;
  /** Codex runtime driver for codex sessions. Absent means use the server default. */
  codexDriver?: CodexDriver;
  /** Last selected permission mode for this session. */
  permissionMode?: string;
  /** Agent controls persisted for this session and restored on every resume. */
  agentSettings?: AgentSessionSettings;
  /** Set after clear-context until the next fresh backend session replaces this id. */
  contextClearedAt?: string;
  /** One-shot context used to seed a new native thread after a harness transfer. */
  pendingHandoffContext?: string;
  /** Transfer lineage retained independently of provider-native thread IDs. */
  transferLineage?: {
    sourceSessionId: string;
    sourceBackend: Backend;
    sourceServerLabel?: string;
    transferredAt: string;
    mode: "move" | "clone";
  };
  /** Full-session delegation lineage, distinct from provider-native subagents. */
  delegatedBySessionId?: string;
  delegationId?: string;
  /**
   * Canonical supervisor whose AgentSession delegation namespace this session
   * may access. Used by scheduled continuation sessions; absent means `id`.
   */
  delegationSupervisorSessionId?: string;
}

export interface ErrorServerMessage {
  type: "error";
  message: string;
}

export interface BackendAuthRequiredServerMessage {
  type: "backend_auth_required";
  backend: Backend;
  authScope?: "openai" | "mcp";
  mcpServerName?: string;
  message: string;
  detail?: string;
  sessionId?: string;
}

export interface PushTokenRegisteredServerMessage {
  type: "push_token_registered";
  appServerId?: string;
}

export interface PushTokenUnregisteredServerMessage {
  type: "push_token_unregistered";
  appServerId?: string;
}

export interface PushRegistrationStatusServerMessage {
  type: "push_registration_status";
  appServerId?: string;
  registered: boolean;
}

export interface ServerCapabilitiesMessage {
  type: "server_capabilities";
  /** Human-readable SocketAgent server release version (for example 1.1.0). */
  serverReleaseVersion?: string;
  /** Exact running git commit when the server was started from a checkout. */
  serverCommit?: string;
  binaryEnvelope?: boolean;
  binaryFileDownloadVersion?: number;
  transportLane?: TransportLane;
  transportLanes?: {
    version: number;
    bulk: boolean;
  };
  uploadAckVersion?: number;
  secretManagement?: {
    version: number;
  };
  htmlPlans?: {
    version: number;
  };
  workReviews?: {
    version: number;
    privateDrafts: true;
    atomicFinish: true;
  };
  sessionTransfer?: {
    version: number;
  };
  codexGoals?: {
    version: number;
  };
  /** Backends supported by this server build. Health/auth state is in backendHealth. */
  backends: Backend[];
  codexDriver?: CodexDriver;
  codexDriversAvailable?: CodexDriver[];
  backendHealth?: BackendHealthInfo[];
  directE2e?: {
    serverPubkey: string;
  };
  relayPairing?: {
    relayUrl: string;
    pairingToken: string;
    serverPubkey: string;
  };
}

export interface UploadChunkAckServerMessage {
  type: "upload_chunk_ack";
  uploadId: string;
  chunkIndex: number;
  receivedChunks: number;
  bytesReceived: number;
}

export interface BackendHealthInfo {
  backend: Backend;
  enabled: boolean;
  available: boolean;
  severity: "ok" | "warning" | "error" | "disabled";
  source?: "explicit" | "sdk" | "managed" | "legacy" | "system" | "path" | "unresolved";
  command?: string;
  version?: string;
  reason?: string;
  detail?: string;
  installRoot?: string;
}

export interface ServerSettingsMessage {
  type: "server_settings";
  codexDriver: CodexDriver;
  defaultCwd: string;
  systemPrompt: string;
  systemPromptInitialized?: boolean;
  /** Null explicitly means use the Claude SDK/model default. */
  claudeAutoCompactWindow: number | null;
  codexDriversAvailable: CodexDriver[];
  backendHealth?: BackendHealthInfo[];
}

export interface BackendInstallProgressServerMessage {
  type: "backend_install_progress";
  requestId?: string;
  backend: Backend;
  operation?: "repair" | "auth";
  phase: "install" | "auth" | "probe";
  status: "running" | "completed" | "failed" | "cancelled";
  message: string;
  output?: string;
  authUrl?: string;
  authCode?: string;
}

export interface SessionCreatedServerMessage {
  type: "session_created";
  sessionId: string;
  /** Previous session ID when clear-context created this replacement. */
  replacesSessionId?: string;
  cwd: string;
  title?: string;
  /** Echoed back so the client knows which backend the server is using. */
  backend?: Backend;
  permissionMode?: string;
}

export interface SessionArchiveFailedServerMessage {
  type: "session_archive_failed";
  sessionId: string;
  error: string;
}

export interface HistoryEntry {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "tool_image" | "question" | "secure_input" | "html_plan" | "work_review" | "todos_update" | "codex_plan" | "user_uuid" | "elicitation_url" | "prompt_suggestion" | "monitor" | "notification" | "task_state" | "permission_mode" | "run_boundary";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolOutput?: string;
  /** Non-terminal Agent async-launch acknowledgement; completion arrives later. */
  backgroundPending?: boolean;
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  /** Content identity at advertisement time; distinct from the delivery ID. */
  fileVersion?: string;
  // Server-internal large-output storage. These fields may be present in
  // persisted history; the server hydrates toolOutput before sending to clients.
  toolOutputRef?: string;
  toolOutputBytes?: number;
  toolOutputStoredBytes?: number;
  toolOutputPreview?: string;
  toolOutputEncoding?: "gzip";
  timestamp: string;
  // Question fields (role === "question")
  questionId?: string;
  questions?: QuestionItem[];
  emailPreview?: EmailPreview;
  answered?: boolean;
  /** Safe, user-visible answers. Never used for secure-input values. */
  answers?: Record<string, string>;
  /**
   * Safe routing metadata for a resumable private-integration authorization
   * card. Credential values are never stored here.
   */
  authRequest?: {
    kind: string;
    requestId: string;
    startUrl: string;
    captureOrigins: string[];
  };
  // Subagent hierarchy and message tracking
  parentToolUseId?: string | null;
  uuid?: string;
  // Tool summary fields
  toolSummary?: boolean;
  precedingToolUseIds?: string[];
  // Thinking block
  thinking?: boolean;
  /** Estimated reasoning tokens, when reported by the backend. */
  thinkingTokens?: number;
  /** Wall-clock duration of the completed reasoning block. */
  thinkingDurationMs?: number;
  // Tool image fields (role === "tool_image")
  filePath?: string;
  mimeType?: string;
  // Elicitation URL fields (role === "elicitation_url")
  mcpServerName?: string;
  url?: string;
  // Monitor fields (role === "monitor")
  taskId?: string;
  description?: string;
  // Notification fields (role === "notification")
  status?: string;
  originToolUseId?: string;
  taskType?: string;
  /** Durable lifecycle category; native checklist tasks are not subagents. */
  taskKind?: "claude_task" | "subagent" | "workflow" | "background";
  taskSubject?: string;
  taskDescription?: string;
  teammateName?: string;
  progressSummary?: string;
  lastToolName?: string;
  isBackgrounded?: boolean;
  skipTranscript?: boolean;
  subagentType?: string;
  taskUsage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
  workflowState?: WorkflowStatePayload;
  commandName?: string;
  commandPayload?: Record<string, unknown>;
  // Permission mode fields (role === "permission_mode")
  permissionMode?: string;
  // Logical run boundary fields (role === "run_boundary")
  runId?: string;
  runNumber?: number;
  runStartedAt?: string;
  runFinishedAt?: string;
  runDurationMs?: number;
  runOutcome?: SessionRunOutcome;
  // Work Review fields (role === "work_review"). Private drafts are never
  // stored in chat history; workReview is the public/card projection only.
  reviewId?: string;
  workReview?: Record<string, unknown>;
  /** Stable transcript identity shared by live delivery and history replay. */
  entryId?: string;
  /** Monotonic position within one SocketAgent session. */
  sessionSeq?: number;
  /** Monotonic content revision for streamed entries. */
  revision?: number;
  /** Stable backend stream identity used to join live frames to history. */
  streamId?: string;
}

export type SessionRunOutcome = "completed" | "stopped" | "failed";

export interface SessionRunRecord {
  runId: string;
  runNumber: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: SessionRunOutcome;
  source?: "observed" | "sdk_backfill" | "transcript_estimate";
}

export interface SessionRunCurrent {
  runId: string;
  startedAt: string;
  /** False while the supervisor is executing or expecting a continuation. */
  supervisorSettled?: boolean;
  /** Outcome to use once all delegated continuations have been delivered. */
  pendingOutcome?: SessionRunOutcome;
}

export interface SessionRunStats {
  current?: SessionRunCurrent;
  completedCount: number;
  totalDurationMs: number;
  averageDurationMs?: number;
  longestDurationMs?: number;
  shortestDurationMs?: number;
  lastCompletedAt?: string;
  /** Newest 500 runs for Analytics; lifetime aggregates remain exact. */
  recentRuns?: SessionRunRecord[];
  /** Versioned lazy migration marker for historical transcript reconstruction. */
  backfillVersion?: number;
}

export interface SessionHistoryServerMessage {
  type: "session_history";
  sessionId: string;
  messages: HistoryEntry[];
  /** Echoed from resume_session.historyRequestId or load_more_history.requestId. */
  requestId?: string;
  /** Explicit merge behavior; clients must not infer this from local state. */
  historyKind?: "initial" | "delta" | "older" | "append";
  /** Total durable entries currently stored for the session. */
  total?: number;
  /** Zero-based position of the first entry in messages. */
  offset?: number;
  /** True when older context was intentionally deferred from first paint. */
  deferredContextAvailable?: boolean;
  /** Total durable user prompts in the session, used to bound background backfill. */
  totalUserPrompts?: number;
  /** Echoed client trace identifier for click-to-ready diagnostics. */
  openTraceId?: string;
  /** Authoritative native task list, independent of the bounded history page. */
  todos?: Record<string, unknown>[];
  /** Latest lifecycle revision for tasks/subagents, independent of the delta cursor. */
  taskStates?: HistoryEntry[];
  /** Authoritative logical-run aggregates, including a current run if active. */
  runStats?: SessionRunStats;
}

export interface SessionRunCompletedServerMessage {
  type: "session_run_completed";
  sessionId: string;
  runStats: SessionRunStats;
  boundary: HistoryEntry;
}

export interface WorkReviewSnapshotServerMessage {
  type: "work_review_snapshot";
  requestId?: string;
  reviewId: string;
  /** Exact originating SocketAgent session, not the currently visible one. */
  sessionId: string;
  review: Record<string, unknown>;
  /** Reviewer-private mutable state; absent once there is no open draft. */
  draft?: WorkReviewDraft;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface WorkReviewListResultServerMessage {
  type: "work_review_list_result";
  requestId?: string;
  reviews: Record<string, unknown>[];
}

export interface WorkReviewOperationResultServerMessage {
  type: "work_review_operation_result";
  requestId: string;
  operation: "get" | "draft_update" | "finish" | "cancel" | "archive" | "restore";
  reviewId: string;
  roundId?: string;
  ok: boolean;
  error?: string;
  review?: Record<string, unknown>;
  draft?: WorkReviewDraft;
  resultId?: string;
  published?: boolean;
}

/**
 * Durable card update. All revisions for one review reuse the same entryId and
 * sessionSeq. It contains only the public review projection.
 */
export interface WorkReviewCardServerMessage {
  type: "work_review_card";
  reviewId: string;
  sessionId: string;
  review: Record<string, unknown>;
  entryId: string;
  sessionSeq: number;
  revision: number;
  deliveryId?: string;
  replay?: boolean;
}

export interface StatusServerMessage {
  type: "status";
  sessionId: string;
  running: boolean;
  compacting?: boolean;
  activeStartedAt?: string;
  activeToolUseId?: string;
  permissionMode?: string;
}

export interface AbortAckServerMessage {
  type: "abort_ack";
  requestId: string;
  sessionId: string;
  stopped: boolean;
  alreadyStopped?: boolean;
  error?: string;
}

export interface CompactingServerMessage {
  type: "compacting";
  active: boolean;
  sessionId: string;
}

export interface FileChunkServerMessage {
  type: "file_chunk";
  fileId: string;
  fileName: string;
  fileSize: number;
  offsetBytes?: number;
  transferToken?: string;
  fileVersion?: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
}

/** Registers a server-side file for a SendFile card before transfer starts. */
export interface FileAvailableServerMessage {
  type: "file";
  fileId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  fileVersion?: string;
  sessionId: string;
  /** Exact canonical SendFile card this transport registration belongs to. */
  toolUseId?: string;
  entryId?: string;
  deliveryId?: string;
  replay?: boolean;
}

export interface FileCompleteServerMessage {
  type: "file_complete";
  fileId: string;
  fileName: string;
  fileSize?: number;
  transferToken?: string;
  fileVersion?: string;
}

export interface FileErrorServerMessage {
  type: "file_error";
  fileId: string;
  message: string;
  transferToken?: string;
}

export interface UploadCompleteServerMessage {
  type: "upload_complete";
  uploadId: string;
  serverPath: string;
}

export interface FileManagerEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size?: number;
  modifiedAt?: string;
  hidden: boolean;
  extension?: string;
  mimeType?: string;
  mediaKind?: "image" | "video" | "audio" | "text" | "archive" | "code" | "other";
  protected: boolean;
  protectedLabel?: string;
}

export interface FileManagerListResultServerMessage {
  type: "file_manager_list_result";
  requestId?: string;
  ok: boolean;
  path: string;
  parentPath?: string;
  entries: FileManagerEntry[];
  roots: Array<{ label: string; path: string }>;
  offset?: number;
  limit?: number;
  totalCount?: number;
  nextOffset?: number;
  hasMore?: boolean;
  error?: string;
  errorCode?: string;
  permission?: Record<string, unknown>;
}

export interface FileManagerStatResultServerMessage {
  type: "file_manager_stat_result";
  requestId?: string;
  ok: boolean;
  path: string;
  entry?: FileManagerEntry;
  error?: string;
  errorCode?: string;
  permission?: Record<string, unknown>;
}

export interface MacosPermissionStatusServerMessage {
  type: "macos_permission_status_result";
  requestId?: string;
  supported: boolean;
  platform: NodeJS.Platform;
  access: "granted" | "denied" | "unknown" | "not_applicable";
  path: string;
  helperInstalled: boolean;
  helperActive: boolean;
  helperPath: string;
  settingsPane: string;
  error?: string;
  errorCode?: string;
}

export interface MacosPermissionActionServerMessage {
  type: "macos_permission_action_result";
  requestId?: string;
  ok: boolean;
  action: string;
  helperPath: string;
  restarting?: boolean;
  error?: string;
}

export interface FileManagerProtectedResultServerMessage {
  type: "file_manager_protected_result";
  requestId?: string;
  ok: boolean;
  path: string;
  protected: boolean;
  entry?: { path: string; label?: string };
  removed?: { path: string; label?: string };
  entries?: Array<{ path: string; label?: string }>;
  error?: string;
}

export interface FileManagerOperationResultServerMessage {
  type: "file_manager_operation_result";
  requestId?: string;
  operation: "download" | "mkdir" | "rename" | "delete" | "upload_start" | "write_text";
  ok: boolean;
  path?: string;
  newPath?: string;
  fileId?: string;
  uploadId?: string;
  error?: string;
}

export interface FileManagerTextResultServerMessage {
  type: "file_manager_text_result";
  requestId?: string;
  ok: boolean;
  path: string;
  content?: string;
  truncated?: boolean;
  bytesRead?: number;
  error?: string;
}

export interface ReminderServerMessage {
  type: "reminder";
  title: string;
  body: string;
  scheduledTime: string;
  notificationId: number;
  sessionId: string;
}

export interface CompactBoundaryServerMessage {
  type: "compact_boundary";
  trigger: string;
  preTokens: number;
  sessionId: string;
}

export interface TaskNotificationServerMessage {
  type: "task_notification";
  taskId: string;
  status: "started" | "completed" | "failed" | "stopped";
  outputFile?: string;
  summary: string;
  sessionId: string;
  originToolUseId?: string;
  parentToolUseId?: string | null;
  subagentType?: string;
  usage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
  skipTranscript?: boolean;
  uuid?: string;
}

export interface CodexCommandResultServerMessage {
  type: "codex_command_result";
  taskId: string;
  command: string;
  status: "completed" | "failed" | "stopped" | string;
  summary: string;
  payload: Record<string, unknown>;
  sessionId: string;
  parentToolUseId?: string | null;
}

export interface CodexGoalStateServerMessage {
  type: "codex_goal_state";
  sessionId: string;
  goal: CodexGoal | null;
  requestId?: string;
  ok: boolean;
  error?: string;
}

export interface ToolSummaryServerMessage {
  type: "tool_summary";
  summary: string;
  precedingToolUseIds: string[];
  sessionId: string;
  parentToolUseId?: string | null;
  uuid?: string;
}

export interface SessionForkedServerMessage {
  type: "session_forked";
  originalSessionId: string;
  newSessionId: string;
  cwd: string;
}

export interface RewindConversationResultServerMessage {
  type: "rewind_conversation_result";
  sessionId: string;
  success: boolean;
  userMessageUuid: string;
  dryRun?: boolean;
  filesReverted?: string[];
  insertions?: number;
  deletions?: number;
  messagesRemoved?: number;
  error?: string;
}

export interface BranchResultServerMessage {
  type: "branch_result";
  success: boolean;
  originalSessionId: string;
  newSessionId?: string;
  branchPointUuid: string;
  cwd?: string;
  error?: string;
}

export interface TtsAudioServerMessage {
  type: "tts_audio";
  audioData: string;
  text: string;
  sessionId: string;
}

export interface ActiveSubagentsServerMessage {
  type: "active_subagents";
  sessionId: string;
  replace?: boolean;
  backend?: Backend;
  tasks: {
    agentId: string;
    toolUseId: string;
    description: string;
    subagentType: string;
    startedAt: string;
    status?: "pending" | "running" | "completed" | "interrupted" | "errored" | "shutdown";
    prompt?: string;
    model?: string;
    reasoningEffort?: string;
    agentPath?: string;
    isBackgrounded?: boolean;
    progressSummary?: string;
    lastToolName?: string;
    usage?: {
      totalTokens: number;
      toolUses: number;
      durationMs: number;
    };
    parentToolUseId?: string | null;
  }[];
}

export interface ScheduledTaskListServerMessage {
  type: "scheduled_task_list";
  tasks: import("./scheduled-task-store").ScheduledTask[];
  revision?: string;
}

export interface ScheduledTaskUpdateServerMessage {
  type: "scheduled_task_update";
  task: import("./scheduled-task-store").ScheduledTask;
}

export interface ScheduledTaskNotificationServerMessage {
  type: "scheduled_task_notification";
  title: string;
  body: string;
  sessionId: string;
  status?: "completed" | "failed" | "manual";
  sessionCompletion?: boolean;
  kind?: string;
  eventId?: string;
  navigationTarget?: "scheduled_tasks";
  scheduledTaskId?: string;
  fcmDispatched?: boolean;
}

// SDK event forwarding messages

export interface RateLimitEventServerMessage {
  type: "rate_limit_event";
  backend: Backend;
  status: string;
  resetsAt?: string;
  utilization?: number;
  utilizationPercent?: number;
  rateLimitType?: string;
  sessionId: string;
}

export interface TaskStartedServerMessage {
  type: "task_started";
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType?: string;
  subagentType?: string;
  workflowName?: string;
  prompt?: string;
  skipTranscript?: boolean;
  sessionId: string;
}

export interface BgTaskProgressServerMessage {
  type: "bg_task_progress";
  taskId: string;
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  usage?: Record<string, unknown>;
  lastToolName?: string;
  summary?: string;
  sessionId: string;
}

export interface TaskUpdatedServerMessage {
  type: "task_updated";
  taskId: string;
  toolUseId?: string;
  patch: {
    status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
    description?: string;
    endTime?: number;
    totalPausedMs?: number;
    error?: string;
    isBackgrounded?: boolean;
  };
  sessionId: string;
}

export interface BackgroundTasksChangedServerMessage {
  type: "background_tasks_changed";
  /** Authoritative replacement snapshot for Claude SDK background work. */
  tasks: {
    taskId: string;
    taskType: string;
    description: string;
    toolUseId?: string;
  }[];
  sessionId: string;
}

export interface WorkflowPhaseState {
  title: string;
  detail?: string;
}

export interface WorkflowProgressState {
  type: "workflow_phase" | "workflow_agent" | string;
  index?: number;
  title?: string;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  state?: string;
  startedAt?: number;
  queuedAt?: number;
  lastProgressAt?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  attempt?: number;
  promptPreview?: string;
  resultPreview?: string;
  error?: string;
}

export interface WorkflowStatePayload {
  taskId: string;
  toolUseId?: string;
  runId?: string;
  workflowName?: string;
  summary: string;
  status: string;
  scriptPath?: string;
  transcriptDir?: string;
  statePath?: string;
  startTime?: number;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  defaultModel?: string;
  phases: WorkflowPhaseState[];
  progress: WorkflowProgressState[];
  logs: string[];
  resultPreview?: string;
}

export interface WorkflowStateServerMessage extends WorkflowStatePayload {
  type: "workflow_state";
  sessionId: string;
}

export interface ApiRetryServerMessage {
  type: "api_retry";
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorStatus?: number;
  sessionId: string;
}

export interface LocalCommandOutputServerMessage {
  type: "local_command_output";
  content: string;
  sessionId: string;
}

export interface PromptSuggestionServerMessage {
  type: "prompt_suggestion";
  suggestion: string;
  sessionId: string;
}

export interface SessionLifecycleServerMessage {
  type: "session_lifecycle";
  event: "start" | "end";
  source?: string;
  reason?: string;
  model?: string;
  agentType?: string;
  sessionId: string;
}

export interface SessionSettingsServerMessage {
  type: "session_settings";
  sessionId: string;
  settings: AgentSessionSettings;
}

export interface SupportedModelsServerMessage {
  type: "supported_models";
  models: Array<Record<string, unknown>>;
  currentModel?: string;
  sessionId: string;
  backend: Backend;
  cached?: boolean;
  updatedAt?: string;
}

export interface MonitorStartedServerMessage {
  type: "monitor_started";
  taskId: string;
  description: string;
  monitoring: boolean;
  command?: string;
  sessionId: string;
}

export interface MonitorOutputServerMessage {
  type: "monitor_output";
  taskId: string;
  content: string;
  /** Cumulative state for snapshot-aware clients; content remains a legacy chunk. */
  snapshotContent?: string;
  sessionId: string;
  description?: string;
  /** Cumulative card state. Legacy servers may still send append-only chunks. */
  snapshot?: boolean;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
  deliveryId?: string;
}

export interface TaskCompletedHookServerMessage {
  type: "task_completed_hook";
  taskId: string;
  subject: string;
  description?: string;
  teammateName?: string;
  sessionId: string;
}

export interface ElicitationUrlServerMessage {
  type: "elicitation_url";
  questionId: string;
  mcpServerName: string;
  message: string;
  url: string;
  elicitationId?: string;
  sessionId: string;
}

export interface HookStartedServerMessage {
  type: "hook_started";
  hookId: string;
  hookName: string;
  hookEvent: string;
  sessionId: string;
}

export interface HookProgressServerMessage {
  type: "hook_progress";
  hookId: string;
  hookName: string;
  hookEvent: string;
  stdout: string;
  stderr: string;
  sessionId: string;
}

export interface HookResponseServerMessage {
  type: "hook_response";
  hookId: string;
  hookName: string;
  hookEvent: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  outcome: string;
  sessionId: string;
}

export interface UsageUpdateServerMessage {
  type: "usage_update";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  contextWindow: number;
  sessionId: string;
}

export interface TerminalStatusServerMessage {
  type: "terminal_status";
  running: boolean;
  pid?: number;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  exitCode?: number;
}

export interface TerminalOutputServerMessage {
  type: "terminal_output";
  data: string;
  replay?: boolean;
}

export interface TerminalExitedServerMessage {
  type: "terminal_exited";
  exitCode: number;
  signal?: number;
}

export interface TerminalErrorServerMessage {
  type: "terminal_error";
  message: string;
}

export interface PhoneAdbRequestServerMessage {
  type: "phone_adb_request";
  requestId: string;
  command: string;
  shellCommand?: string;
  args?: string[];
  timeoutSeconds?: number;
  maxBytes?: number;
  fileName?: string;
  fileSize?: number;
}

export interface PhoneAdbFileChunkServerMessage {
  type: "phone_adb_file_chunk";
  requestId: string;
  chunkIndex: number;
  data: string;
}

export interface PhoneAdbFileEndServerMessage {
  type: "phone_adb_file_end";
  requestId: string;
  ok: boolean;
  message?: string;
}

export interface PhoneAdbCancelServerMessage {
  type: "phone_adb_cancel";
  requestId: string;
}

export type ServerMessage =
  | TextServerMessage
  | ToolCallServerMessage
  | ToolResultServerMessage
  | QuestionServerMessage
  | QuestionAnsweredServerMessage
  | SecureInputRequestServerMessage
  | SecureInputSavedServerMessage
  | SecretInventoryServerMessage
  | SecretOperationResultServerMessage
  | HtmlPlanServerMessage
  | HtmlPlanListServerMessage
  | HtmlPlanOperationResultServerMessage
  | HtmlPlanRevisionListServerMessage
  | HtmlPlanRevisionServerMessage
  | WorkReviewSnapshotServerMessage
  | WorkReviewListResultServerMessage
  | WorkReviewOperationResultServerMessage
  | WorkReviewCardServerMessage
  | ResultServerMessage
  | SessionListServerMessage
  | SdkSessionListServerMessage
  | ErrorServerMessage
  | PromptReceivedServerMessage
  | PromptFailedServerMessage
  | BackendAuthRequiredServerMessage
  | PushTokenRegisteredServerMessage
  | PushTokenUnregisteredServerMessage
  | PushRegistrationStatusServerMessage
  | ServerCapabilitiesMessage
  | ServerSettingsMessage
  | BackendInstallProgressServerMessage
  | SessionCreatedServerMessage
  | SessionArchiveFailedServerMessage
  | SessionHistoryServerMessage
  | SessionRunCompletedServerMessage
  | StatusServerMessage
  | AbortAckServerMessage
  | CompactingServerMessage
  | UploadChunkAckServerMessage
  | FileAvailableServerMessage
  | FileChunkServerMessage
  | FileCompleteServerMessage
  | FileErrorServerMessage
  | UploadCompleteServerMessage
  | FileManagerListResultServerMessage
  | FileManagerStatResultServerMessage
  | MacosPermissionStatusServerMessage
  | MacosPermissionActionServerMessage
  | FileManagerProtectedResultServerMessage
  | FileManagerOperationResultServerMessage
  | FileManagerTextResultServerMessage
  | ReminderServerMessage
  | CompactBoundaryServerMessage
  | TaskNotificationServerMessage
  | CodexCommandResultServerMessage
  | CodexGoalStateServerMessage
  | ToolSummaryServerMessage
  | SessionForkedServerMessage
  | RewindConversationResultServerMessage
  | BranchResultServerMessage
  | TtsAudioServerMessage
  | ThinkingServerMessage
  | ThinkingTokensServerMessage
  | ToolImageServerMessage
  | ActiveSubagentsServerMessage
  | ScheduledTaskListServerMessage
  | ScheduledTaskUpdateServerMessage
  | ScheduledTaskNotificationServerMessage
  | RateLimitEventServerMessage
  | TaskStartedServerMessage
  | BgTaskProgressServerMessage
  | TaskUpdatedServerMessage
  | BackgroundTasksChangedServerMessage
  | WorkflowStateServerMessage
  | ApiRetryServerMessage
  | LocalCommandOutputServerMessage
  | PromptSuggestionServerMessage
  | SessionLifecycleServerMessage
  | SessionSettingsServerMessage
  | SupportedModelsServerMessage
  | TaskCompletedHookServerMessage
  | ElicitationUrlServerMessage
  | UsageUpdateServerMessage
  | HookStartedServerMessage
  | HookProgressServerMessage
  | HookResponseServerMessage
  | MonitorStartedServerMessage
  | MonitorOutputServerMessage
  | TerminalStatusServerMessage
  | TerminalOutputServerMessage
  | TerminalExitedServerMessage
  | TerminalErrorServerMessage
  | PhoneAdbRequestServerMessage
  | PhoneAdbFileChunkServerMessage
  | PhoneAdbFileEndServerMessage
  | PhoneAdbCancelServerMessage;

// ── Client → Server messages ──

export interface PromptMessage {
  type: "prompt";
  text: string;
  sessionId?: string;
}

export interface AnswerMessage {
  type: "answer";
  questionId: string;
  answers: Record<string, string>;
}

export interface NewSessionMessage {
  type: "new_session";
  cwd?: string;
}

export interface ResumeSessionMessage {
  type: "resume_session";
  sessionId: string;
}

export interface ListSessionsMessage {
  type: "list_sessions";
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
}

export interface LoadMoreHistoryMessage {
  type: "load_more_history";
  sessionId: string;
  offset: number;
  limit: number;
}

export interface CheckCwdMessage {
  type: "check_cwd";
  path: string;
}

export interface CreateCwdMessage {
  type: "create_cwd";
  path: string;
}

export interface ClearContextMessage {
  type: "clear_context";
  sessionId: string;
}

export interface UploadStartMessage {
  type: "upload_start";
  uploadId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
}

export interface UploadChunkMessage {
  type: "upload_chunk";
  uploadId: string;
  chunkIndex: number;
  data: string;
}

export interface SetEffortMessage {
  type: "set_effort";
  effort: "low" | "medium" | "high" | "max";
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
}

export interface SetSystemPromptMessage {
  type: "set_system_prompt";
  prompt: string;
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
  cwd: string;
}

export interface ScheduleTaskMessage {
  type: "schedule_task";
  prompt: string;
  cwd: string;
  scheduledTime: string;
  recurrence?: {
    type: "once" | "daily" | "weekly" | "monthly" | "custom";
    intervalMs?: number;
  };
  reuseSession?: boolean;
}

export interface ListScheduledTasksMessage {
  type: "list_scheduled_tasks";
}

export interface CancelScheduledTaskMessage {
  type: "cancel_scheduled_task";
  taskId: string;
}

export interface UpdateScheduledTaskMessage {
  type: "update_scheduled_task";
  taskId: string;
  prompt?: string;
  cwd?: string;
  scheduledTime?: string;
  recurrence?: { type: "once" | "daily" | "weekly" | "monthly" | "custom"; intervalMs?: number } | null;
  reuseSession?: boolean;
}

export interface DeleteScheduledTaskMessage {
  type: "delete_scheduled_task";
  taskId: string;
}

export type ClientMessage =
  | PromptMessage
  | AnswerMessage
  | NewSessionMessage
  | ResumeSessionMessage
  | ListSessionsMessage
  | DeleteSessionMessage
  | RenameSessionMessage
  | ClearContextMessage
  | AbortMessage
  | InterruptMessage
  | SetTtsMessage
  | SetTtsEngineMessage
  | RequestTtsAudioMessage
  | SetEffortMessage
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
  | UploadStartMessage
  | UploadChunkMessage
  | ScheduleTaskMessage
  | ListScheduledTasksMessage
  | CancelScheduledTaskMessage
  | UpdateScheduledTaskMessage
  | DeleteScheduledTaskMessage
  | { type: "auth_code"; code: string; sessionId?: string }
  | { type: "version_check" }
  | { type: "force_update" }
  | { type: "get_recent_cwds" }
  | { type: "add_recent_cwd"; cwd: string }
  | { type: "remove_recent_cwd"; cwd: string }
  | { type: "skills_list" }
  | { type: "skills_save"; name: string; scope: string; format: string; frontmatter: Record<string, string>; body: string; filePath?: string }
  | { type: "skills_delete"; filePath: string }
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
  parentToolUseId?: string | null;
  uuid?: string;
}

export interface ToolCallServerMessage {
  type: "tool_call";
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
  parentToolUseId?: string | null;
  uuid?: string;
}

export interface ToolResultServerMessage {
  type: "tool_result";
  toolUseId: string;
  output: string;
  sessionId: string;
  parentToolUseId?: string | null;
  uuid?: string;
}

export interface ToolImageServerMessage {
  type: "tool_image";
  toolUseId: string;
  imageData: string;
  mimeType: string;
  filePath: string;
  sessionId: string;
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
  parentToolUseId?: string | null;
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

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  lastActive: string;
  messagePreview: string;
  running?: boolean;
  lastUsage?: UsageInfo & { costUsd?: number; numTurns?: number };
  scheduledTaskId?: string;
}

export interface ErrorServerMessage {
  type: "error";
  message: string;
}

export interface SessionCreatedServerMessage {
  type: "session_created";
  sessionId: string;
  cwd: string;
}

export interface HistoryEntry {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "tool_image" | "question" | "todos_update" | "user_uuid" | "elicitation_url" | "prompt_suggestion";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolOutput?: string;
  timestamp: string;
  // Question fields (role === "question")
  questionId?: string;
  questions?: QuestionItem[];
  emailPreview?: EmailPreview;
  answered?: boolean;
  // Subagent hierarchy and message tracking
  parentToolUseId?: string | null;
  uuid?: string;
  // Tool summary fields
  toolSummary?: boolean;
  precedingToolUseIds?: string[];
  // Thinking block
  thinking?: boolean;
  // Tool image fields (role === "tool_image")
  filePath?: string;
  mimeType?: string;
  // Elicitation URL fields (role === "elicitation_url")
  mcpServerName?: string;
  url?: string;
}

export interface SessionHistoryServerMessage {
  type: "session_history";
  sessionId: string;
  messages: HistoryEntry[];
}

export interface StatusServerMessage {
  type: "status";
  sessionId: string;
  running: boolean;
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
  chunkIndex: number;
  totalChunks: number;
  data: string;
}

export interface FileCompleteServerMessage {
  type: "file_complete";
  fileId: string;
  fileName: string;
}

export interface UploadCompleteServerMessage {
  type: "upload_complete";
  uploadId: string;
  serverPath: string;
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
  status: "completed" | "failed" | "stopped";
  outputFile?: string;
  summary: string;
  sessionId: string;
  parentToolUseId?: string | null;
  uuid?: string;
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

export interface DesktopCliStatusServerMessage {
  type: "desktop_cli_status";
  sessionId: string;
  active: boolean;
  pid?: number;
}

export interface ActiveSubagentsServerMessage {
  type: "active_subagents";
  sessionId: string;
  tasks: {
    agentId: string;
    toolUseId: string;
    description: string;
    subagentType: string;
    startedAt: string;
  }[];
}

export interface ScheduledTaskListServerMessage {
  type: "scheduled_task_list";
  tasks: import("./scheduled-task-store").ScheduledTask[];
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
}

// SDK event forwarding messages

export interface RateLimitEventServerMessage {
  type: "rate_limit_event";
  status: string;
  resetsAt?: string;
  utilization?: number;
  rateLimitType?: string;
  sessionId: string;
}

export interface TaskStartedServerMessage {
  type: "task_started";
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType?: string;
  prompt?: string;
  sessionId: string;
}

export interface BgTaskProgressServerMessage {
  type: "bg_task_progress";
  taskId: string;
  description?: string;
  usage?: Record<string, unknown>;
  lastToolName?: string;
  summary?: string;
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
  sessionId: string;
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

export type ServerMessage =
  | TextServerMessage
  | ToolCallServerMessage
  | ToolResultServerMessage
  | QuestionServerMessage
  | ResultServerMessage
  | SessionListServerMessage
  | ErrorServerMessage
  | SessionCreatedServerMessage
  | SessionHistoryServerMessage
  | StatusServerMessage
  | CompactingServerMessage
  | FileChunkServerMessage
  | FileCompleteServerMessage
  | UploadCompleteServerMessage
  | ReminderServerMessage
  | CompactBoundaryServerMessage
  | TaskNotificationServerMessage
  | ToolSummaryServerMessage
  | SessionForkedServerMessage
  | RewindConversationResultServerMessage
  | BranchResultServerMessage
  | TtsAudioServerMessage
  | ThinkingServerMessage
  | ToolImageServerMessage
  | DesktopCliStatusServerMessage
  | ActiveSubagentsServerMessage
  | ScheduledTaskListServerMessage
  | ScheduledTaskUpdateServerMessage
  | ScheduledTaskNotificationServerMessage
  | RateLimitEventServerMessage
  | TaskStartedServerMessage
  | BgTaskProgressServerMessage
  | ApiRetryServerMessage
  | LocalCommandOutputServerMessage
  | PromptSuggestionServerMessage
  | SessionLifecycleServerMessage
  | TaskCompletedHookServerMessage
  | ElicitationUrlServerMessage
  | UsageUpdateServerMessage
  | HookStartedServerMessage
  | HookProgressServerMessage
  | HookResponseServerMessage
  | MonitorStartedServerMessage
  | MonitorOutputServerMessage;

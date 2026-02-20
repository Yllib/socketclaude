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

export interface AbortMessage {
  type: "abort";
}

export interface SetTtsMessage {
  type: "set_tts";
  enabled: boolean;
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

export interface StopTaskMessage {
  type: "stop_task";
  taskId: string;
}

export interface ForkSessionMessage {
  type: "fork_session";
  sessionId: string;
}

export type ClientMessage =
  | PromptMessage
  | AnswerMessage
  | NewSessionMessage
  | ResumeSessionMessage
  | ListSessionsMessage
  | DeleteSessionMessage
  | ClearContextMessage
  | AbortMessage
  | SetTtsMessage
  | SetEffortMessage
  | SetThinkingMessage
  | StopTaskMessage
  | ForkSessionMessage
  | RequestFileMessage
  | LoadMoreHistoryMessage
  | CheckCwdMessage
  | CreateCwdMessage
  | UploadStartMessage
  | UploadChunkMessage;

// ── Server → Client messages ──

export interface TextServerMessage {
  type: "text";
  content: string;
  sessionId: string;
}

export interface ToolCallServerMessage {
  type: "tool_call";
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
}

export interface ToolResultServerMessage {
  type: "tool_result";
  toolUseId: string;
  output: string;
  sessionId: string;
}

export interface EmailPreview {
  to: string;
  subject: string;
  body: string;
  cc?: string;
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
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  contextWindow: number;
}

export interface ResultServerMessage {
  type: "result";
  content: string;
  sessionId: string;
  costUsd?: number;
  durationMs?: number;
  usage?: UsageInfo;
  numTurns?: number;
  stopReason?: string;
  resultSubtype?: string;
  errors?: string[];
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
  role: "user" | "assistant" | "tool_call" | "tool_result" | "question";
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
}

export interface SessionForkedServerMessage {
  type: "session_forked";
  originalSessionId: string;
  newSessionId: string;
  cwd: string;
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
  | SessionForkedServerMessage;

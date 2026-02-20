import { WebSocket } from "ws";
import { ServerMessage } from "./protocol";
import * as http from "http";

/** Context provided to plugins at init time (server-level state) */
export interface PluginContext {
  getActiveSessions: () => Map<string, any>;
  getConnectedClients: () => Set<WebSocket>;
  getPort: () => number;
  getDefaultCwd: () => string;
}

/** Context provided per-session (passed to canUseTool interceptors, answer middleware, etc.) */
export interface SessionContext {
  sessionId: string;
  cwd: string;
  send: (msg: ServerMessage | Record<string, any>) => void;
  pendingQuestions: Map<string, { questionId: string; resolve: (answers: Record<string, string>) => void }>;
  questionCounter: { next: () => string };
}

/** canUseTool interceptor result — return null to pass to next handler */
export type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: any }
  | { behavior: "deny"; message: string }
  | null;

/** Answer middleware result */
export type AnswerResult =
  | { handled: true }
  | { handled: false };

export interface SocketClaudePlugin {
  name: string;

  /** Called once at server startup */
  init?(ctx: PluginContext): void | Promise<void>;

  /** Called on server shutdown */
  cleanup?(): void | Promise<void>;

  /** Handle HTTP requests. Return true if handled, false to pass through. */
  httpHandler?(req: http.IncomingMessage, res: http.ServerResponse): boolean;

  /** canUseTool interceptor — called before built-in handlers. Return null to pass through. */
  canUseToolInterceptor?(
    toolName: string,
    input: Record<string, any>,
    sessionCtx: SessionContext
  ): Promise<CanUseToolResult>;

  /** Answer middleware — called before default question resolution */
  answerMiddleware?(
    questionId: string,
    answers: Record<string, string>,
    sessionCtx: SessionContext
  ): AnswerResult | Promise<AnswerResult>;

  /** Additional MCP servers to register with the SDK */
  mcpServers?(): Record<string, any>;

  /** Additional tool patterns to allow (e.g. ["mcp__my-tools__*"]) */
  allowedTools?(): string[];

  /** Tool context prompt fragment (appended to base prompt on first message) */
  toolContextFragment?(): string;

  /** Extra environment variables to inject into SDK queries */
  envVars?(): Record<string, string>;
}

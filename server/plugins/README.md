# SocketClaude Plugins

Drop compiled `.js` plugin files in this directory. They are loaded automatically at server startup.

## Plugin Interface

Export a default object implementing `SocketClaudePlugin` from `../src/plugin-api`:

```typescript
import { SocketClaudePlugin } from "../src/plugin-api";

const myPlugin: SocketClaudePlugin = {
  name: "my-plugin",

  // Optional: runs once at server startup
  init(ctx) {
    console.log(`${this.name} loaded`);
  },

  // Optional: handle HTTP requests (return true if handled)
  httpHandler(req, res) {
    if (req.method === "POST" && req.url === "/my-endpoint") {
      res.writeHead(200);
      res.end("OK");
      return true;
    }
    return false;
  },

  // Optional: intercept canUseTool (return null to pass through)
  async canUseToolInterceptor(toolName, input, sessionCtx) {
    return null;
  },

  // Optional: intercept answer messages (return { handled: false } to pass through)
  async answerMiddleware(questionId, answers, sessionCtx) {
    return { handled: false };
  },

  // Optional: contribute MCP servers
  mcpServers() {
    return {};
  },

  // Optional: contribute allowed tool patterns
  allowedTools() {
    return [];
  },

  // Optional: append to the tool context prompt
  toolContextFragment() {
    return "";
  },

  // Optional: inject env vars into SDK queries
  envVars() {
    return {};
  },
};

export default myPlugin;
```

## Notes

- Plugins run in the same Node.js process (trusted code, not sandboxed)
- Compile TypeScript plugins to JS before placing here: `npx tsc plugin.ts --outDir .`
- Plugin files (except this README) are gitignored — they stay private to your machine
- All hooks are optional — implement only what you need

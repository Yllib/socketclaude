interface BlockState { index: number; type: string; claimed: boolean }
interface MessageState { blocks: BlockState[]; completed: Map<string, string[]> }

/** API message ids identify a model response, not individual SDK content blocks. */
export class ClaudeStreamIdentity {
  private active = new Map<string, string>();
  private messages = new Map<string, MessageState>();

  clear(): void { this.active.clear(); this.messages.clear(); }

  private messageKey(message: any): string {
    const lane = String(message.parent_tool_use_id || "main");
    const event = message.type === "stream_event" ? message.event : null;
    const id = event?.message?.id || message.message?.id;
    if (id) this.active.set(lane, String(id));
    return `${lane}:${id || this.active.get(lane) || message.uuid || "current"}`;
  }

  private state(key: string): MessageState {
    let state = this.messages.get(key);
    if (!state) {
      state = { blocks: [], completed: new Map() };
      this.messages.set(key, state);
      // Keep completed-message reconciliation bounded in warm sessions.
      if (this.messages.size > 512) this.messages.delete(this.messages.keys().next().value!);
    }
    return state;
  }

  streamKey(message: any): string {
    const key = this.messageKey(message);
    const event = message.event;
    if (message.type !== "stream_event" || !Number.isInteger(event?.index)) return key;
    const state = this.state(key);
    if (!state.blocks.some(block => block.index === event.index)) {
      const type = event.content_block?.type
        || (event.delta?.type === "thinking_delta" ? "thinking"
          : event.delta?.type === "text_delta" ? "text" : "tool_use");
      state.blocks.push({ index: event.index, type, claimed: false });
    }
    return `${key}:block:${event.index}`;
  }

  completedKeys(message: any): string[] {
    const key = this.messageKey(message);
    const state = this.state(key);
    const uuid = String(message.uuid || "");
    const existing = uuid && state.completed.get(uuid);
    if (existing) return existing;
    const keys = (message.message?.content || []).map((block: any, offset: number) => {
      const streamed = state.blocks.find(candidate => !candidate.claimed && candidate.type === block.type);
      if (streamed) {
        streamed.claimed = true;
        return `${key}:block:${streamed.index}`;
      }
      // Without partial events the SDK's outer UUID is the block identity.
      return `${key}:complete:${uuid || "unknown"}:${offset}`;
    });
    if (uuid) state.completed.set(uuid, keys);
    return keys;
  }
}

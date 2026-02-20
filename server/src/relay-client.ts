import WebSocket from "ws";
import { KeyPair, EncryptedEnvelope, encrypt, decrypt, toBase64, fromBase64 } from "./relay-crypto";
import { ClientMessage } from "./protocol";

export type RelayStatus = "disconnected" | "connecting" | "waiting_for_peer" | "paired" | "error";

export interface RelayClientOptions {
  relayUrl: string;
  pairingToken: string;
  keyPair: KeyPair;
  onMessage: (msg: ClientMessage) => void;
  onStatusChange: (status: RelayStatus) => void;
}

/**
 * Outbound WebSocket connection from server to relay.
 * Auto-reconnects, handles NaCl key exchange with the phone,
 * and encrypts/decrypts all bridged messages.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private phonePublicKey: Uint8Array | null = null;
  private status: RelayStatus = "disconnected";
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  // Virtual WebSocket interface for ClaudeSession compatibility
  private virtualWs: VirtualRelaySocket;

  constructor(private opts: RelayClientOptions) {
    this.virtualWs = new VirtualRelaySocket(this);
  }

  /** Get a WebSocket-like object that ClaudeSession can use */
  getVirtualSocket(): VirtualRelaySocket {
    return this.virtualWs;
  }

  /** Connect to the relay server */
  connect(): void {
    if (this.closed) return;
    this.setStatus("connecting");

    const url = `${this.opts.relayUrl}?token=${encodeURIComponent(this.opts.pairingToken)}&role=server`;
    console.log(`[Relay] Connecting to ${this.opts.relayUrl}...`);

    try {
      this.ws = new WebSocket(url);
    } catch (err: any) {
      console.error(`[Relay] Connection error: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log(`[Relay] Connected, waiting for phone...`);
      this.reconnectDelay = 1000; // reset backoff
      this.setStatus("waiting_for_peer");
    });

    this.ws.on("message", (data) => {
      try {
        const raw = data.toString();
        const parsed = JSON.parse(raw);
        this.handleRelayMessage(parsed);
      } catch (err: any) {
        console.error(`[Relay] Failed to parse message: ${err.message}`);
      }
    });

    this.ws.on("close", () => {
      console.log(`[Relay] Disconnected`);
      this.ws = null;
      this.phonePublicKey = null;
      this.virtualWs._setOpen(false);
      this.setStatus("disconnected");
      if (!this.closed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error(`[Relay] Error: ${err.message}`);
      // close event will follow
    });
  }

  /** Send a server→client message through the relay (encrypted if paired) */
  send(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const json = JSON.stringify(msg);

    if (this.phonePublicKey) {
      // Encrypted mode
      const envelope = encrypt(json, this.phonePublicKey, this.opts.keyPair.secretKey);
      this.ws.send(JSON.stringify(envelope));
    } else {
      // Pre-key-exchange: send plaintext (only used for key_exchange_ack)
      this.ws.send(json);
    }
  }

  /** Whether the relay is connected and paired with a phone */
  get isPaired(): boolean {
    return this.status === "paired" && this.phonePublicKey !== null;
  }

  get currentStatus(): RelayStatus {
    return this.status;
  }

  /** Disconnect and stop reconnecting */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  private handleRelayMessage(parsed: any): void {
    // Relay control messages (unencrypted)
    if (parsed.type === "peer_connected") {
      console.log(`[Relay] Phone connected to relay`);
      this.setStatus("waiting_for_peer"); // Will become "paired" after key exchange
      return;
    }

    if (parsed.type === "peer_disconnected") {
      console.log(`[Relay] Phone disconnected from relay`);
      this.phonePublicKey = null;
      this.virtualWs._setOpen(false);
      this.setStatus("waiting_for_peer");
      return;
    }

    // Key exchange (plaintext from phone)
    if (parsed.type === "key_exchange") {
      console.log(`[Relay] Received phone public key`);
      this.phonePublicKey = fromBase64(parsed.pubkey);
      this.setStatus("paired");
      this.virtualWs._setOpen(true);

      // Send ack PLAINTEXT — phone needs this to confirm handshake before
      // encrypted mode begins. Contains no sensitive data.
      if (this.ws) {
        this.ws.send(JSON.stringify({ type: "key_exchange_ack" }));
      }
      console.log(`[Relay] Key exchange complete — encrypted channel established`);
      return;
    }

    // Encrypted message from phone
    if (parsed.n && parsed.c) {
      if (!this.phonePublicKey) {
        console.error(`[Relay] Received encrypted message before key exchange`);
        return;
      }
      try {
        const plaintext = decrypt(
          parsed as EncryptedEnvelope,
          this.phonePublicKey,
          this.opts.keyPair.secretKey
        );
        const msg = JSON.parse(plaintext) as ClientMessage;
        this.opts.onMessage(msg);
      } catch (err: any) {
        console.error(`[Relay] Decryption failed: ${err.message}`);
      }
      return;
    }

    console.warn(`[Relay] Unknown message type: ${parsed.type || "no type"}`);
  }

  private setStatus(status: RelayStatus): void {
    this.status = status;
    this.opts.onStatusChange(status);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.setStatus("disconnected");
    console.log(`[Relay] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff: 1s → 2s → 4s → ... → 30s max
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}

/**
 * WebSocket-like wrapper that makes the relay connection compatible
 * with ClaudeSession's existing ws interface (readyState + send).
 */
export class VirtualRelaySocket {
  readyState: number = WebSocket.CLOSED;
  private _onMessageCallbacks: ((data: Buffer) => void)[] = [];
  private _onCloseCallbacks: (() => void)[] = [];

  constructor(private relay: RelayClient) {}

  send(data: string): void {
    try {
      const msg = JSON.parse(data);
      this.relay.send(msg);
    } catch {
      // If it's not JSON, send raw
      this.relay.send({ raw: data });
    }
  }

  /** Called by RelayClient when pairing status changes */
  _setOpen(open: boolean): void {
    const wasOpen = this.readyState === WebSocket.OPEN;
    this.readyState = open ? WebSocket.OPEN : WebSocket.CLOSED;
    if (wasOpen && !open) {
      for (const cb of this._onCloseCallbacks) cb();
    }
  }

  /** Deliver an incoming message (from relay) to anyone listening */
  _deliverMessage(data: string): void {
    for (const cb of this._onMessageCallbacks) {
      cb(Buffer.from(data));
    }
  }

  // Minimal EventEmitter-like interface for compatibility
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === "message") this._onMessageCallbacks.push(cb);
    if (event === "close") this._onCloseCallbacks.push(cb);
  }
}

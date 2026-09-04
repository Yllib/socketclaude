import * as fs from "fs";
import * as path from "path";
import { GoogleAuth } from "google-auth-library";
import { socketAgentDataPath } from "./socket-agent-paths";

interface StoredPushToken {
  token: string;
  platform: string;
  appServerId?: string;
  deliveryRoute?: "relay" | "direct";
  firebaseProjectId?: string;
  updatedAt: string;
}

export interface PushNotificationPayload {
  title: string;
  body?: string;
  sessionId?: string;
  status?: string;
  kind?: string;
  data?: Record<string, string | number | boolean | null | undefined>;
  showNotification?: boolean;
}

export type DirectFcmConfigurationIssue = "missing" | "invalid" | "unreadable";

export interface PushDeliveryCapabilities {
  directFcmConfigured: boolean;
  directFcmIssue?: DirectFcmConfigurationIssue;
  directFcmProjectId?: string;
  relayConfigured: boolean;
}

export function shouldSendForwardedPush(message: Record<string, any>): boolean {
  return message.type === "scheduled_task_notification"
    && message.fcmDispatched !== true;
}

const sentAttentionEvents = new Map<string, number>();

/**
 * Questions and secure-input requests are live UI events, but FCM is the sole
 * notification transport. Replays use sendTo() and never reach this helper;
 * this process-level guard also prevents duplicate sends across session objects.
 */
export function maybeSendAgentAttentionPush(
  message: Record<string, any>,
  fallbackTitle = "SocketAgent",
): void {
  const type = String(message.type || "");
  if (type !== "question" && type !== "secure_input_request") return;
  const sessionId = String(message.sessionId || "");
  if (!sessionId) return;
  const interactionId = type === "question"
    ? String(message.questionId || "")
    : String(message.requestId || "");
  if (!interactionId) return;
  const eventId = `${type}:${sessionId || "none"}:${interactionId}`;
  if (sentAttentionEvents.has(eventId)) return;
  const now = Date.now();
  sentAttentionEvents.set(eventId, now);
  if (sentAttentionEvents.size > 1000) {
    for (const [key, timestamp] of sentAttentionEvents) {
      if (now - timestamp > 24 * 60 * 60 * 1000 || sentAttentionEvents.size > 800) {
        sentAttentionEvents.delete(key);
      }
    }
  }

  const firstQuestion = Array.isArray(message.questions)
    ? String(message.questions[0]?.question || "").trim()
    : "";
  const label = String(message.label || "Secret").trim() || "Secret";
  const body = type === "question"
    ? (firstQuestion || "Your agent needs your input")
    : `Secure input requested: ${label}`;
  const kind = type === "question" ? "input_required" : "secure_input_required";
  sendPushNotification({
    title: fallbackTitle.trim() || "SocketAgent",
    body: body.length > 220 ? `${body.slice(0, 217)}...` : body,
    sessionId,
    status: "manual",
    kind,
    data: { eventId },
    showNotification: false,
  }).then((result) => {
    if (result.attempted > 0) {
      console.log(`[Push] FCM sent ${result.sent}/${result.attempted} for ${type} session=${sessionId || "none"}`);
    }
  }).catch((err) => {
    console.warn(`[Push] ${type} push error: ${err?.message || err}`);
  });
}

const STORE_PATH = process.env.PUSH_TOKEN_STORE
  || socketAgentDataPath("push-tokens.json");

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
let cachedCredentials: Record<string, unknown> | null | undefined;
let fcmAuth: GoogleAuth | null = null;
let fcmProjectId: string | null = null;

function readStore(): StoredPushToken[] {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((entry) => entry?.token) : [];
  } catch {
    return [];
  }
}

function writeStore(entries: StoredPushToken[]): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 });
}

export function registerPushToken(
  fcmToken: string,
  platform = "android",
  appServerId?: string,
  deliveryRoute?: "relay" | "direct",
  firebaseProjectId?: string,
): void {
  const token = fcmToken.trim();
  if (!token) return;

  const withoutToken = readStore().filter((entry) => {
    if (entry.token === token) return false;
    return !(
      appServerId
      && deliveryRoute
      && entry.appServerId === appServerId
      && entry.deliveryRoute === deliveryRoute
    );
  });
  writeStore([
    ...withoutToken,
    {
      token,
      platform,
      ...(appServerId ? { appServerId } : {}),
      ...(deliveryRoute ? { deliveryRoute } : {}),
      ...(firebaseProjectId ? { firebaseProjectId } : {}),
      updatedAt: new Date().toISOString(),
    },
  ].slice(-20));
}

export function unregisterPushToken(
  fcmToken: string,
  appServerId?: string,
): void {
  const token = fcmToken.trim();
  if (!token) return;

  writeStore(readStore().filter((entry) => {
    if (entry.token !== token) return true;
    if (!appServerId) return false;
    return entry.appServerId !== appServerId;
  }));
}

export function isPushTokenRegistered(
  fcmToken: string,
  appServerId?: string,
  deliveryRoute?: "relay" | "direct",
): boolean {
  const token = fcmToken.trim();
  if (!token) return false;
  return readStore().some((entry) => (
    entry.token === token
      && (!appServerId || entry.appServerId === appServerId)
      && (!deliveryRoute || entry.deliveryRoute === deliveryRoute)
  ));
}

function hasRequiredServiceAccountFields(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credentials = value as Record<string, unknown>;
  const hasProject = typeof credentials.project_id === "string"
    && credentials.project_id.trim().length > 0;
  const hasExplicitProject = Boolean(
    process.env.FIREBASE_PROJECT_ID
      || process.env.GOOGLE_CLOUD_PROJECT
      || process.env.GCLOUD_PROJECT,
  );
  return typeof credentials.client_email === "string"
    && credentials.client_email.trim().length > 0
    && typeof credentials.private_key === "string"
    && credentials.private_key.trim().length > 0
    && (hasProject || hasExplicitProject);
}

function directFcmConfiguration(): Pick<
  PushDeliveryCapabilities,
  "directFcmConfigured" | "directFcmIssue" | "directFcmProjectId"
> {
  const explicitProjectId = String(
    process.env.FIREBASE_PROJECT_ID
      || process.env.GOOGLE_CLOUD_PROJECT
      || process.env.GCLOUD_PROJECT
      || "",
  ).trim();
  const resultForCredentials = (
    credentials: Record<string, unknown>,
  ): Pick<
    PushDeliveryCapabilities,
    "directFcmConfigured" | "directFcmIssue" | "directFcmProjectId"
  > => {
    if (!hasRequiredServiceAccountFields(credentials)) {
      return { directFcmConfigured: false, directFcmIssue: "invalid" };
    }
    const credentialProjectId = typeof credentials.project_id === "string"
      ? credentials.project_id.trim()
      : "";
    return {
      directFcmConfigured: true,
      directFcmProjectId: explicitProjectId || credentialProjectId,
    };
  };
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (rawJson) {
    try {
      return resultForCredentials(JSON.parse(rawJson));
    } catch {
      return { directFcmConfigured: false, directFcmIssue: "invalid" };
    }
  }

  const credentialsPath = String(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      || process.env.GOOGLE_APPLICATION_CREDENTIALS
      || "",
  ).trim();
  if (!credentialsPath) {
    return { directFcmConfigured: false, directFcmIssue: "missing" };
  }
  try {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    return resultForCredentials(credentials);
  } catch (error: unknown) {
    const hasFileErrorCode = error !== null
      && typeof error === "object"
      && "code" in error;
    return {
      directFcmConfigured: false,
      directFcmIssue: hasFileErrorCode ? "unreadable" : "invalid",
    };
  }
}

export function getPushDeliveryCapabilities(): PushDeliveryCapabilities {
  return {
    ...directFcmConfiguration(),
    relayConfigured: relayPushEndpoint() !== null,
  };
}

export function isPushConfigured(): boolean {
  const capabilities = getPushDeliveryCapabilities();
  return capabilities.directFcmConfigured || capabilities.relayConfigured;
}

function relayPushEndpoint(): string | null {
  const relayUrl = String(process.env.RELAY_URL || "").trim();
  const pairingToken = String(process.env.PAIRING_TOKEN || "").trim();
  if (!relayUrl || !pairingToken) return null;
  try {
    const url = new URL(relayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    url.pathname = "/api/push/send";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function sendPushViaRelay(
  endpoint: string,
  pairingToken: string,
  payload: PushNotificationPayload,
): Promise<{ sent: number; attempted: number }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingToken,
      title: payload.title,
      body: payload.body || "",
      sessionId: payload.sessionId || "",
      status: payload.status || "manual",
      kind: payload.kind || "",
      showNotification: payload.showNotification !== false,
      data: payload.data || {},
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as any;
  if (!response.ok || body?.ok !== true) {
    throw new Error(`relay FCM request failed (${response.status}): ${body?.error || "unknown error"}`);
  }
  return {
    sent: Number.isFinite(Number(body.sent)) ? Number(body.sent) : 0,
    attempted: Number.isFinite(Number(body.attempted)) ? Number(body.attempted) : 0,
  };
}

function loadServiceAccountCredentials(): Record<string, unknown> | null {
  if (cachedCredentials !== undefined) return cachedCredentials;
  try {
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (rawJson) {
      const credentials = JSON.parse(rawJson) as Record<string, unknown>;
      cachedCredentials = credentials;
      return credentials;
    }
    if (serviceAccountPath) {
      const credentials = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8")) as Record<string, unknown>;
      cachedCredentials = credentials;
      return credentials;
    }
    cachedCredentials = null;
    return null;
  } catch (err: any) {
    console.error(`[Push] Firebase credentials could not be read: ${err.message || err}`);
    cachedCredentials = null;
    return null;
  }
}

function getFcmAuth(): GoogleAuth | null {
  if (fcmAuth) return fcmAuth;
  const credentials = loadServiceAccountCredentials();
  if (credentials) {
    fcmAuth = new GoogleAuth({ credentials, scopes: [FCM_SCOPE] });
    return fcmAuth;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    fcmAuth = new GoogleAuth({ scopes: [FCM_SCOPE] });
    return fcmAuth;
  }
  console.warn("[Push] Firebase credentials not configured; push notifications disabled");
  return null;
}

async function getFcmProjectId(auth: GoogleAuth): Promise<string | null> {
  if (fcmProjectId) return fcmProjectId;
  const explicit = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (explicit) {
    fcmProjectId = explicit;
    return fcmProjectId;
  }
  const credentials = loadServiceAccountCredentials();
  const credentialProject = typeof credentials?.project_id === "string" ? credentials.project_id : "";
  if (credentialProject) {
    fcmProjectId = credentialProject;
    return fcmProjectId;
  }
  try {
    fcmProjectId = await auth.getProjectId();
    return fcmProjectId;
  } catch (err: any) {
    console.error(`[Push] Firebase project ID could not be resolved: ${err.message || err}`);
    return null;
  }
}

function removeTokens(tokensToRemove: Set<string>): void {
  if (tokensToRemove.size === 0) return;
  writeStore(readStore().filter((entry) => !tokensToRemove.has(entry.token)));
}

function fcmDetailErrorCode(err: any): string {
  const details = err?.response?.data?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const type = typeof detail?.["@type"] === "string" ? detail["@type"] : "";
      if (type.includes("google.firebase.fcm.v1.FcmError") && typeof detail?.errorCode === "string") {
        return detail.errorCode;
      }
    }
  }
  return "";
}

function fcmErrorCode(err: any): string {
  const fcmCode = fcmDetailErrorCode(err);
  if (fcmCode) return fcmCode;
  return err?.response?.data?.error?.status || err?.code || "";
}

function isInvalidFcmTokenError(err: any): boolean {
  const code = fcmDetailErrorCode(err);
  return code === "UNREGISTERED" || code === "INVALID_ARGUMENT";
}

async function sendFcmHttpV1(
  auth: GoogleAuth,
  projectId: string,
  token: string,
  data: Record<string, string>,
  payload: PushNotificationPayload,
): Promise<void> {
  const client = await auth.getClient();
  const message: Record<string, unknown> = {
    token,
    data,
    android: {
      priority: "HIGH",
    },
  };

  if (payload.showNotification !== false) {
    message.notification = {
      title: payload.title,
      body: payload.body || "",
    };
    message.android = {
      priority: "HIGH",
      notification: {
        channel_id: "session_alerts",
        notification_priority: "PRIORITY_HIGH",
        default_sound: true,
        default_vibrate_timings: true,
      },
    };
  }

  await client.request({
    method: "POST",
    url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    data: { message },
  });
}

export async function sendPushNotification(
  payload: PushNotificationPayload,
): Promise<{ sent: number; attempted: number }> {
  // Test processes inherit the developer's relay credentials. Never let a
  // fixture notification escape to a real enrolled device.
  if (process.env.SOCKETAGENT_TEST_MODE === "1") {
    return { sent: 0, attempted: 0 };
  }
  const entries = readStore();
  const endpoint = relayPushEndpoint();
  const pairingToken = String(process.env.PAIRING_TOKEN || "").trim();
  const relayEntries = entries.filter(
    (entry) => entry.deliveryRoute !== "direct",
  );
  let relayResult: { sent: number; attempted: number } | null = null;
  if (
    endpoint &&
    pairingToken &&
    (entries.length === 0 || relayEntries.length > 0)
  ) {
    try {
      relayResult = await sendPushViaRelay(endpoint, pairingToken, payload);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Push] Relay delivery failed, checking direct Firebase fallback: ${message}`,
      );
    }
  }

  if (entries.length === 0) {
    return relayResult ?? { sent: 0, attempted: 0 };
  }

  const directEntries = relayResult && relayResult.attempted > 0
    ? entries.filter((entry) => entry.deliveryRoute === "direct")
    : entries;
  if (directEntries.length === 0) {
    return relayResult ?? { sent: 0, attempted: 0 };
  }
  const auth = getFcmAuth();
  if (!auth) {
    return {
      sent: relayResult?.sent ?? 0,
      attempted: (relayResult?.attempted ?? 0) + directEntries.length,
    };
  }
  const projectId = await getFcmProjectId(auth);
  if (!projectId) {
    return {
      sent: relayResult?.sent ?? 0,
      attempted: (relayResult?.attempted ?? 0) + directEntries.length,
    };
  }
  const projectEntries = directEntries.filter(
    (entry) => !entry.firebaseProjectId || entry.firebaseProjectId === projectId,
  );
  const tokens = projectEntries.map((entry) => entry.token).filter(Boolean);
  if (tokens.length === 0) {
    return relayResult ?? { sent: 0, attempted: 0 };
  }

  const groups = new Map<string, StoredPushToken[]>();
  for (const entry of projectEntries) {
    const key = entry.appServerId || "";
    groups.set(key, [...(groups.get(key) || []), entry]);
  }

  let sent = 0;
  const invalid = new Set<string>();
  for (const [appServerId, group] of groups) {
    const groupTokens = group.map((entry) => entry.token).filter(Boolean);
    if (groupTokens.length === 0) continue;
    const data: Record<string, string> = {
      title: payload.title,
      body: payload.body || "",
      sessionId: payload.sessionId || "",
      serverId: appServerId,
      status: payload.status || "manual",
      kind: payload.kind || "",
    };
    for (const [key, value] of Object.entries(payload.data || {})) {
      data[key] = value == null ? "" : String(value);
    }

    for (const token of groupTokens) {
      try {
        await sendFcmHttpV1(auth, projectId, token, data, payload);
        sent++;
      } catch (err: any) {
        const code = fcmErrorCode(err);
        if (isInvalidFcmTokenError(err)) {
          invalid.add(token);
        }
        console.warn(`[Push] FCM send failed: ${code || err?.message || "unknown error"}`);
      }
    }
  }
  removeTokens(invalid);
  return {
    sent: sent + (relayResult?.sent ?? 0),
    attempted: tokens.length + (relayResult?.attempted ?? 0),
  };
}

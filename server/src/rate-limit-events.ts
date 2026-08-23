export type HarnessRateLimitType =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet"
  | "seven_day_overage_included"
  | "overage"
  | string;

export interface RateLimitEventPayload {
  type: "rate_limit_event";
  backend: "claude" | "codex";
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: string;
  utilization?: number;
  utilizationPercent?: number;
  rateLimitType?: HarnessRateLimitType;
  sessionId: string;
}

export function rateLimitWindowForType(
  value: HarnessRateLimitType | undefined,
): "five_hour" | "weekly" {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized.includes("seven_day")
    || normalized.includes("seven-day")
    || normalized.includes("weekly")
    || normalized.includes("week")
    ? "weekly"
    : "five_hour";
}

/** Normalize legacy Claude rate-limit events that may report a 0-1 ratio. */
export function normalizeUtilizationPercent(value: unknown): number | undefined {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return undefined;
  const percent = raw >= 0 && raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, percent));
}

/** Normalize a field whose wire contract is already percentage points. */
export function normalizeExplicitPercent(value: unknown): number | undefined {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(100, raw));
}

export function normalizeResetTime(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  const millis = raw < 1_000_000_000_000 ? raw * 1000 : raw;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function statusForUtilization(
  percent: number | undefined,
): RateLimitEventPayload["status"] {
  if (percent === undefined) return "allowed";
  if (percent >= 100) return "rejected";
  if (percent >= 85) return "allowed_warning";
  return "allowed";
}

export function buildClaudeRateLimitEvent(
  info: Record<string, unknown>,
  sessionId: string,
): RateLimitEventPayload {
  const utilizationPercent = normalizeUtilizationPercent(info.utilization);
  return {
    type: "rate_limit_event",
    backend: "claude",
    status:
      info.status === "rejected" || info.status === "allowed_warning"
        ? info.status
        : "allowed",
    resetsAt: normalizeResetTime(info.resetsAt),
    ...(utilizationPercent === undefined
      ? {}
      : {
          utilization: utilizationPercent / 100,
          utilizationPercent,
        }),
    ...(typeof info.rateLimitType === "string"
      ? { rateLimitType: info.rateLimitType }
      : {}),
    sessionId,
  };
}

export function buildClaudeUsageRateLimitEvents(
  usage: Record<string, any> | null | undefined,
  sessionId: string,
): RateLimitEventPayload[] {
  if (!usage?.rate_limits_available || !usage.rate_limits || !sessionId) {
    return [];
  }
  const limits = usage.rate_limits as Record<string, any>;
  const fiveHour = limits.five_hour
    ? [{ type: "five_hour", value: limits.five_hour }]
    : [];
  const weeklyCandidates = [
    ["seven_day", limits.seven_day],
    ["seven_day_opus", limits.seven_day_opus],
    ["seven_day_sonnet", limits.seven_day_sonnet],
  ]
    .filter((entry) => entry[1])
    .map(([type, value]) => ({
      type: String(type),
      value: value as Record<string, unknown>,
      // The structured Claude SDK /usage contract reports percentage points.
      // Unlike legacy rate_limit_event payloads, 1 means 1%, not 100%.
      percent: normalizeExplicitPercent(
        (value as Record<string, unknown>).utilization,
      ),
    }))
    .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
  const selected = [
    ...fiveHour,
    ...(weeklyCandidates.length > 0 ? [weeklyCandidates[0]] : []),
  ];
  return selected.map(({ type, value }) => {
    const utilizationPercent = normalizeExplicitPercent(value.utilization);
    return {
      type: "rate_limit_event",
      backend: "claude",
      status: statusForUtilization(utilizationPercent),
      resetsAt: normalizeResetTime(value.resets_at),
      ...(utilizationPercent === undefined
        ? {}
        : {
            utilization: utilizationPercent / 100,
            utilizationPercent,
          }),
      rateLimitType: type,
      sessionId,
    };
  });
}

function codexWindowType(
  window: Record<string, unknown>,
  fallback: "five_hour" | "seven_day",
): "five_hour" | "seven_day" {
  const duration = Number(window.windowDurationMins);
  if (!Number.isFinite(duration)) return fallback;
  return duration >= 7 * 24 * 60 ? "seven_day" : "five_hour";
}

export function buildCodexRateLimitEvents(
  rateLimits: Record<string, any> | null | undefined,
  sessionId: string,
): RateLimitEventPayload[] {
  if (!rateLimits || !sessionId) return [];
  const windows: Array<{
    value: Record<string, unknown> | null | undefined;
    fallback: "five_hour" | "seven_day";
  }> = [
    { value: rateLimits.primary, fallback: "five_hour" },
    { value: rateLimits.secondary, fallback: "seven_day" },
  ];
  return windows.flatMap(({ value, fallback }) => {
    if (!value) return [];
    // Codex names this field usedPercent and reports percentage points. In
    // particular, 1 means 1%, not a fractional ratio meaning 100%.
    const utilizationPercent = normalizeExplicitPercent(value.usedPercent);
    const rateLimitType = codexWindowType(value, fallback);
    return [{
      type: "rate_limit_event" as const,
      backend: "codex" as const,
      status: statusForUtilization(utilizationPercent),
      resetsAt: normalizeResetTime(value.resetsAt),
      ...(utilizationPercent === undefined
        ? {}
        : {
            utilization: utilizationPercent / 100,
            utilizationPercent,
          }),
      rateLimitType,
      sessionId,
    }];
  });
}

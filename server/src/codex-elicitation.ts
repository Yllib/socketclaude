import { QuestionItem } from "./protocol";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
const elicitationValidator = new AjvJsonSchemaValidator();

export type CodexMcpElicitationAction = "accept" | "decline" | "cancel";

export interface CodexMcpElicitationResponse {
  action: CodexMcpElicitationAction;
  content: unknown | null;
  _meta: unknown | null;
}

interface ElicitationAnswerBinding {
  property: string;
  question: string;
  schema: Record<string, any>;
  optionValues: Map<string, unknown>;
}

export interface PreparedCodexMcpElicitation {
  serverName: string;
  mode: string;
  message: string;
  url?: string;
  elicitationId?: string;
  meta: unknown | null;
  questions: QuestionItem[];
  bindings: ElicitationAnswerBinding[];
  fallbackApproval: boolean;
  requestedSchema: Record<string, any>;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function optionPairs(schema: Record<string, any>): Array<{ label: string; value: unknown }> {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .filter((entry: unknown) => entry && typeof entry === "object" && "const" in (entry as object))
      .map((entry: Record<string, any>) => ({
        label: String(entry.title ?? entry.const),
        value: entry.const,
      }));
  }

  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((value: unknown, index: number) => ({
      label: String(names[index] ?? value),
      value,
    }));
  }

  const items = asObject(schema.items);
  if (Array.isArray(items.anyOf)) {
    return items.anyOf
      .filter((entry: unknown) => entry && typeof entry === "object" && "const" in (entry as object))
      .map((entry: Record<string, any>) => ({
        label: String(entry.title ?? entry.const),
        value: entry.const,
      }));
  }
  if (Array.isArray(items.enum)) {
    return items.enum.map((value: unknown) => ({ label: String(value), value }));
  }

  if (schema.type === "boolean") {
    return [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ];
  }
  return [];
}

function uniqueQuestionText(base: string, used: Set<string>): string {
  const trimmed = base.trim() || "Please provide a response";
  if (!used.has(trimmed)) {
    used.add(trimmed);
    return trimmed;
  }
  let suffix = 2;
  while (used.has(`${trimmed} (${suffix})`)) suffix += 1;
  const unique = `${trimmed} (${suffix})`;
  used.add(unique);
  return unique;
}

/**
 * Normalize both the current app-server request shape and the short-lived
 * nested shape used by older Codex builds.
 */
export function prepareCodexMcpElicitation(rawParams: unknown): PreparedCodexMcpElicitation {
  const params = asObject(rawParams);
  const legacyRequest = asObject(params.request);
  const legacyParams = asObject(legacyRequest.params);
  const source = Object.keys(legacyParams).length > 0 ? legacyParams : params;
  const serverName = String(params.serverName ?? params.server_name ?? params.name ?? "MCP Server");
  const mode = String(source.mode ?? (source.url ? "url" : "form"));
  const message = String(source.message ?? `${serverName} is requesting your approval or input.`);
  const requestedSchema = asObject(source.requestedSchema ?? source.requested_schema);
  const properties = asObject(requestedSchema.properties);
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.map((entry: unknown) => String(entry))
      : [],
  );
  const questions: QuestionItem[] = [];
  const bindings: ElicitationAnswerBinding[] = [];
  const usedQuestionText = new Set<string>();
  const entries = Object.entries(properties);

  for (const [property, rawSchema] of entries) {
    const schema = asObject(rawSchema);
    const pairs = optionPairs(schema);
    const title = String(schema.title ?? property);
    const description = String(schema.description ?? title);
    const questionBase = entries.length === 1 && message
      ? [message, description !== message ? description : ""].filter(Boolean).join("\n\n")
      : description;
    const question = uniqueQuestionText(questionBase, usedQuestionText);
    const optionValues = new Map<string, unknown>();
    for (const pair of pairs) optionValues.set(pair.label, pair.value);
    questions.push({
      question: required.has(property) ? `${question} (required)` : question,
      header: title,
      options: pairs.map((pair) => ({ label: pair.label })),
      multiSelect: schema.type === "array",
    });
    bindings.push({
      property,
      question: questions[questions.length - 1].question,
      schema,
      optionValues,
    });
  }

  const fallbackApproval = questions.length === 0 && mode !== "url";
  if (fallbackApproval) {
    const question = uniqueQuestionText(message, usedQuestionText);
    questions.push({
      question,
      header: "Approval",
      options: [
        { label: "Approve" },
        { label: "Decline" },
      ],
      multiSelect: false,
    });
  }

  return {
    serverName,
    mode,
    message,
    url: typeof source.url === "string" ? source.url : undefined,
    elicitationId: typeof source.elicitationId === "string" ? source.elicitationId : undefined,
    meta: source._meta ?? null,
    questions,
    bindings,
    fallbackApproval,
    requestedSchema,
  };
}

function splitMultiValue(answer: string): string[] {
  return answer
    .split(/\s*(?:,|\u2014)\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function coerceAnswer(binding: ElicitationAnswerBinding, answer: string): unknown {
  const values = splitMultiValue(answer);
  if (binding.schema.type === "array") {
    return values.map((value) => binding.optionValues.has(value)
      ? binding.optionValues.get(value)
      : value);
  }
  if (values.length === 1 && binding.optionValues.has(values[0])) {
    return binding.optionValues.get(values[0]);
  }
  if (binding.schema.type === "boolean") {
    if (/^(?:true|yes)$/i.test(answer.trim())) return true;
    if (/^(?:false|no)$/i.test(answer.trim())) return false;
    return answer;
  }
  if (binding.schema.type === "number" || binding.schema.type === "integer") {
    const parsed = Number(answer.trim());
    return Number.isFinite(parsed) ? parsed : answer;
  }
  return answer;
}

export function resolveCodexMcpElicitation(
  prepared: PreparedCodexMcpElicitation,
  answers: Record<string, string>,
): CodexMcpElicitationResponse {
  const firstAnswer = String(Object.values(answers)[0] ?? "").trim();
  if (prepared.fallbackApproval) {
    const accepted = /^(?:approve|approved|yes|confirm|confirmed|send|continue)\b/i.test(firstAnswer);
    return {
      action: accepted ? "accept" : "decline",
      content: accepted ? {} : null,
      _meta: null,
    };
  }

  const content: Record<string, unknown> = {};
  for (const binding of prepared.bindings) {
    const answer = answers[binding.question];
    if (answer === undefined || answer.trim() === "") continue;
    content[binding.property] = coerceAnswer(binding, answer);
  }
  if (Object.keys(prepared.requestedSchema).length) {
    const validation = elicitationValidator.getValidator(prepared.requestedSchema)(content);
    if (!validation.valid) throw new Error(validation.errorMessage);
  }
  return { action: "accept", content, _meta: null };
}

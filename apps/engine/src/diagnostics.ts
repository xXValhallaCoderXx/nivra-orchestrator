import { constants } from "node:os";
import { ModelFailureKind } from "@nivra/domain";

/**
 * Safe diagnostics (NIV-27, D29). When something fails, the engine writes one bounded line to its log saying what kind
 * of failure it was, where, and for which run or request, never what the error said: an error's own words can quote
 * the key, the provider or the repository, and masking known keys doesn't make them safe. Every field is
 * application-owned or checked against an allowlist, so a line can be read, kept and shared.
 *
 * The same rule holds for what leaves the engine any other way (public errors, stored failures, run events): only
 * Nivra's own messages, chosen by safe codes and filled with safe values. `publicFailure` says which errors carry such a
 * message. This module imports neither Mastra nor the model client, so any part of the engine can use it.
 */

/** What kind of failure a diagnostic records: a closed list. */
export const DIAGNOSTIC_CODES = [
  "unexpected-error",
  "callback-threw",
  "context-missing",
  "input-unreadable",
  "input-refused",
  "model-failure",
  "refused",
  "repo-refused",
  "git-failed",
  "exec-refused",
  "result-invalid",
  "record-failed",
  "cancel-failed",
  "crashed",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** Where a failure happened: an application-owned token such as `models.list`, `read_file` or `sandbox.spawn`. */
const TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNT_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const ERRNO = new Set(Object.keys(constants.errno));
const NODE_CODE = /^(ERR|UND_ERR)_[A-Z0-9_]{1,60}$|^EAI_[A-Z]{1,20}$/;
const MAX_LINE = 1_000;
const MAX_CLASSES = 4;
const MAX_CAUSES = 8;
const MAX_COUNTS = 8;

/**
 * The error classes a diagnostic may name: JavaScript's and the web platform's own, Nivra's, and its libraries' that
 * carry no data in their names. Any other name is "unknown": a name, too, is text an error chose.
 */
const KNOWN_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "ModelFailure",
  "Refusal",
  "RepoError",
  "RepoCancelled",
  "TaskUnreadable",
  "ChatUnreadable",
  "ReviewUnreadable",
  "RpcFailure",
  "LineTooLongError",
  "ArgsError",
  "TokenFactoryError",
  "RuntimeBrokenError",
  "EngineLockedError",
  "ExecRefusedError",
  "BoundaryUnavailableError",
  "SandboxRefusal",
  "SandboxHttpError",
  "SandboxNetworkError",
  "SandboxDeadlineError",
  "SandboxCancelledError",
  "MastraError",
  "ZodError",
  "AI_APICallError",
  "AI_JSONParseError",
  "AI_TypeValidationError",
  "AI_InvalidResponseDataError",
  "AI_EmptyResponseBodyError",
  "AI_NoContentGeneratedError",
  "AI_RetryError",
  "AI_NoSuchToolError",
  "AI_InvalidToolInputError",
  "AI_InvalidArgumentError",
  "AI_LoadAPIKeyError",
  "AI_UnsupportedFunctionalityError",
  "AI_NoObjectGeneratedError",
  "AI_ToolExecutionError",
]);

/** What a diagnostic says about an error: never its words. */
export interface ErrorFacts {
  /** The cause chain's classes, outermost first, at most four; a class off the allowlist is "unknown". */
  classes: string[];
  /** The first errno or Node error code in the chain, when it is a known one. */
  errno: string | null;
  /** How many causes the chain had beyond the error itself, counted up to eight. */
  causes: number;
  /** The length of the error's own message, which is never recorded; null when it had none. */
  messageChars: number | null;
}

/** A failure's code and stage as the code that caught it says them, with the facts of the error it caught. */
export interface FailureFacts {
  code: DiagnosticCode;
  stage: string;
  error: ErrorFacts | null;
}

/** One diagnostic line's content. Everything is checked again when it is written: an invalid field is dropped. */
export interface Diagnostic {
  code: DiagnosticCode;
  stage: string;
  /** A finer, application-owned reason, such as a refusal's own code. */
  reason?: string | null;
  kind?: string | null;
  error?: ErrorFacts | null;
  run?: string | null;
  request?: string | null;
  workflow?: string | null;
  step?: string | null;
  rpc?: number | string | null;
  method?: string | null;
  counts?: Record<string, number> | null;
}

/** Reads one property without letting a getter, or a proxy, throw past it. */
function read(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** An error's class as a diagnostic may name it: one on the allowlist, or null. */
export function safeClass(error: unknown): string | null {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  const name = read(error, "name");
  return typeof name === "string" && KNOWN_CLASSES.has(name) ? name : null;
}

const classOf = (value: unknown): string => {
  if (value === null) return "(null)";
  if (typeof value !== "object" && typeof value !== "function") return `(${typeof value})`;
  return safeClass(value) ?? "unknown";
};

const errnoOf = (value: unknown): string | null => {
  const code = read(value, "code");
  return typeof code === "string" && (ERRNO.has(code) || NODE_CODE.test(code)) ? code : null;
};

/** What can be said safely about an error: its classes, a known code, how deep its causes go, and its message's length. */
export function errorFacts(error: unknown): ErrorFacts {
  const classes: string[] = [];
  const seen = new Set<unknown>();
  let errno: string | null = null;
  let causes = 0;
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSES; depth++) {
    const isObject = current !== null && (typeof current === "object" || typeof current === "function");
    // A cause seen before closes a cycle: it is neither counted nor named again.
    if (isObject && seen.has(current)) break;
    if (depth > 0) causes++;
    if (classes.length < MAX_CLASSES) classes.push(classOf(current));
    if (!isObject) break;
    seen.add(current);
    errno ??= errnoOf(current);
    const cause = read(current, "cause");
    if (cause === undefined) break;
    current = cause;
  }
  const message = typeof error === "string" ? error : read(error, "message");
  return { classes, errno, causes, messageChars: typeof message === "string" ? message.length : null };
}

const cleanFacts = (facts: unknown): ErrorFacts | null => {
  if (!facts || typeof facts !== "object") return null;
  const classes = read(facts, "classes");
  const errno = read(facts, "errno");
  const causes = read(facts, "causes");
  const messageChars = read(facts, "messageChars");
  return {
    classes: Array.isArray(classes) ? classes.slice(0, MAX_CLASSES).map((c) => (typeof c === "string" && (KNOWN_CLASSES.has(c) || /^\((null|[a-z]+)\)$/.test(c)) ? c : "unknown")) : [],
    errno: typeof errno === "string" && (ERRNO.has(errno) || NODE_CODE.test(errno)) ? errno : null,
    causes: typeof causes === "number" && Number.isInteger(causes) && causes >= 0 ? Math.min(causes, MAX_CAUSES) : 0,
    messageChars: typeof messageChars === "number" && Number.isInteger(messageChars) && messageChars >= 0 ? messageChars : null,
  };
};

/** A failure's facts read back from a stored or serialised error, checked field by field; null when there are none. */
export function readFailureFacts(value: unknown): FailureFacts | null {
  if (!value || typeof value !== "object") return null;
  const code = read(value, "code");
  const stage = read(value, "stage");
  if (typeof code !== "string" || !(DIAGNOSTIC_CODES as readonly string[]).includes(code) || typeof stage !== "string" || !TOKEN.test(stage)) return null;
  return { code: code as DiagnosticCode, stage, error: cleanFacts(read(value, "error")) };
}

const token = (value: unknown): string | null => (typeof value === "string" && TOKEN.test(value) ? value : null);
const uuid = (value: unknown): string | null => (typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null);

/**
 * The line a diagnostic is written as: `diagnostic {json}`, at most 1,000 characters. Every field is checked again
 * here, so a caller can't put text in a diagnostic by mistake: an unknown code reads `unexpected-error`, an invalid
 * stage `unknown`, and any other invalid field is left out.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const kind = typeof diagnostic.kind === "string" && (ModelFailureKind.options as readonly string[]).includes(diagnostic.kind) ? diagnostic.kind : null;
  const rpc =
    typeof diagnostic.rpc === "number" && Number.isSafeInteger(diagnostic.rpc) && diagnostic.rpc >= 0
      ? diagnostic.rpc
      : typeof diagnostic.rpc === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(diagnostic.rpc)
        ? diagnostic.rpc
        : null;
  const counts = Object.entries(diagnostic.counts ?? {})
    .filter(([name, value]) => COUNT_NAME.test(name) && typeof value === "number" && Number.isFinite(value) && value >= 0)
    .slice(0, MAX_COUNTS)
    .map(([name, value]) => [name, Math.round(value)] as const);
  const fields: Record<string, unknown> = {
    code: (DIAGNOSTIC_CODES as readonly string[]).includes(diagnostic.code) ? diagnostic.code : "unexpected-error",
    stage: token(diagnostic.stage) ?? "unknown",
    reason: token(diagnostic.reason),
    kind,
    error: cleanFacts(diagnostic.error),
    run: uuid(diagnostic.run),
    request: uuid(diagnostic.request),
    workflow: token(diagnostic.workflow),
    step: token(diagnostic.step),
    rpc,
    method: typeof diagnostic.method === "string" && /^[a-z][a-zA-Z.]{0,63}$/.test(diagnostic.method) ? diagnostic.method : null,
    counts: counts.length ? Object.fromEntries(counts) : null,
  };
  const present = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
  let line = `diagnostic ${JSON.stringify(present)}`;
  // Each field is bounded, so this is a backstop: the counts go first, then the error's facts.
  for (const field of ["counts", "error"]) {
    if (line.length <= MAX_LINE) break;
    delete present[field];
    line = `diagnostic ${JSON.stringify(present)}`;
  }
  return line.slice(0, MAX_LINE);
}

/** The one message for a failure inside Nivra; `detail` is only ever an allowlisted class name. */
export function internalMessage(detail?: string | null): string {
  return `Something inside Nivra failed${detail ? ` (${detail})` : ""}. Try again; if it keeps happening, report it with the engine log.`;
}

/**
 * A refusal in Nivra's own words, with a safe code. Its message is public, so it is written only from fixed text and
 * safe values (numbers, codes, platform names), never from an error, a command's output or a path.
 */
export class Refusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "Refusal";
    this.code = TOKEN.test(code) ? code : "refused";
  }
}

/** What an execution boundary's errors become at Nivra's own boundary: their text can quote a spawn error or a path. */
export const EXEC_REFUSED_MESSAGE = "Nivra couldn't start a program it needs on this target, so this run stopped. Try again; if it keeps happening, report it with the engine log.";
export const BOUNDARY_UNAVAILABLE_MESSAGE = "The isolation this run needs isn't available on this target, so nothing ran. Check Doctor in Settings for what is missing.";

/** A failure as the app may see it: Nivra's own message, its kind when it has one, and what a diagnostic records. */
export interface PublicFailure {
  message: string;
  kind: string | null;
  retryAfterSeconds: number | null;
  /** Which stage of a review failed, when it was one (D30). */
  stage: string | null;
  code: DiagnosticCode;
  reason: string | null;
  facts: FailureFacts | null;
}

const MAX_MESSAGE = 2_000;
const message = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, MAX_MESSAGE) : null);

/**
 * The public side of a failure, wherever Mastra wrapped or serialised it: the message of the first error in the chain
 * whose message Nivra wrote from fixed text and safe values, or a fixed message for an execution boundary's errors.
 * Null when there is none, so the caller says `internalMessage()` instead of anything the error said.
 */
export function publicFailure(error: unknown): PublicFailure | null {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current);
    const name = read(current, "name");
    const text = message(read(current, "message"));
    const kindValue = read(current, "kind");
    const kind = typeof kindValue === "string" && (ModelFailureKind.options as readonly string[]).includes(kindValue) ? kindValue : null;
    const ownCode = token(read(current, "code"));
    if (name === "ModelFailure" && text) {
      const retry = read(current, "retryAfterSeconds");
      const facts = readFailureFacts(read(current, "facts"));
      const stage = read(current, "stage");
      return {
        message: text,
        kind: kind ?? "internal",
        retryAfterSeconds: typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : null,
        stage: typeof stage === "string" && /^(architecture|risks|single|chair|review)$/.test(stage) ? stage : null,
        code: facts?.code ?? "model-failure",
        reason: null,
        facts,
      };
    }
    if ((name === "TaskUnreadable" || name === "ChatUnreadable" || name === "ReviewUnreadable") && text) return { message: text, kind: "internal", retryAfterSeconds: null, stage: null, code: "input-unreadable", reason: null, facts: null };
    if (name === "Refusal" && text) {
      const exec = ownCode === "exec-refused" || ownCode === "boundary-unavailable";
      return { message: text, kind: null, retryAfterSeconds: null, stage: null, code: exec ? "exec-refused" : "refused", reason: ownCode, facts: null };
    }
    if (name === "RepoError" && text) {
      return { message: text, kind: null, retryAfterSeconds: null, stage: null, code: ownCode === "git-failed" || ownCode === "git-timeout" ? "git-failed" : "repo-refused", reason: ownCode, facts: null };
    }
    if (name === "RepoCancelled") return { message: "Cancelled.", kind: "cancelled", retryAfterSeconds: null, stage: null, code: "refused", reason: "cancelled", facts: null };
    if (name === "ExecRefusedError") return { message: EXEC_REFUSED_MESSAGE, kind: null, retryAfterSeconds: null, stage: null, code: "exec-refused", reason: ownCode, facts: null };
    if (name === "BoundaryUnavailableError") return { message: BOUNDARY_UNAVAILABLE_MESSAGE, kind: null, retryAfterSeconds: null, stage: null, code: "exec-refused", reason: ownCode ?? "boundary-unavailable", facts: null };
    current = read(current, "cause");
  }
  return null;
}

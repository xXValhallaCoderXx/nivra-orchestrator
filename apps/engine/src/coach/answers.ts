import {
  COACH_REPORT_LIMITS,
  CoachField,
  CoachQuestionField,
  type CoachChange,
  type CoachDropped,
  type CoachPacket,
  type CoachQuestion,
  type CoachSuggestedCheck,
  type Mask,
} from "@nivra/domain";
import { z } from "zod";

/**
 * What the coach hands in, and what the engine keeps of it (NIV-53). The coach gets one request, so the schema is as
 * lenient as it can be: every field has a default, and a list may arrive as a string. Whatever the schema refuses
 * never reaches Nivra and costs the request. The engine does the rest, and counts it: a question needs a field the
 * person can update, a change is one per field with only that field's operation, an item it rewords must exist, and
 * every reference must name something the packet holds. A proposal over its limit is set aside, never clipped, since
 * clipping would change what the person is asked to accept. Nothing is ever dropped silently.
 */

/** Short ids a model may send as one string: split on commas, semicolons and white space. */
const Ids = z.union([z.array(z.string()), z.string()]).default([]);
/** Sentences a model may send as one string: split on line breaks only, since a sentence holds commas. */
const Texts = z.union([z.array(z.string()), z.string()]).default([]);

export const CoachAnswer = z.object({
  summary: z
    .string()
    .default("")
    .describe("Two or three sentences on what is already clear and what would make the work easier to check. If the brief is clear enough for a small task, say so and propose nothing. At most 600 characters"),
  questions: z
    .array(
      z.object({
        text: z.string().default("").describe("One question the engineer answers by updating the brief. At most 300 characters"),
        why: z.string().default("").describe("Why its answer matters for checking the work. At most 300 characters"),
        field: z.string().default("").describe("The one field its answer belongs in: goal, acceptanceCriteria, scope, exclusions, context, assumptions, checks or acceptanceCases"),
      }),
    )
    .default([])
    .describe("At most 3, the most important first; none when the brief needs none"),
  changes: z
    .array(
      z.object({
        field: z.string().default("").describe("The field this change is for: goal, scope, exclusions, context, acceptanceCriteria or assumptions. At most one change per field"),
        text: z.string().default("").describe("For goal, scope or exclusions only: the whole new text of that field. At most 1,000 characters"),
        append: z.string().default("").describe("For context only: the words to add at its end. At most 1,500 characters"),
        add: Texts.describe("For acceptanceCriteria or assumptions only: new items, at most 5, each at most 400 characters"),
        reword: z
          .array(
            z.object({
              item: z.union([z.number(), z.string()]).default(0).describe("The item's number as the brief numbers it: 2 for C2 or A2"),
              text: z.string().default("").describe("The item's new wording. At most 400 characters"),
            }),
          )
          .default([])
          .describe("For acceptanceCriteria or assumptions only: existing items to reword, by number, at most 5"),
        reason: z.string().default("").describe("Why this change makes the brief clearer or easier to check. At most 300 characters"),
        refs: Ids.describe("What it answers: G1 for a gap, C2 for a criterion, A1 for an assumption, M for the mission, F1 for a finding"),
      }),
    )
    .default([])
    .describe("Proposed changes, at most one per field; none when the brief needs none. Nothing is ever deleted"),
  suggestedChecks: z
    .array(
      z.object({
        name: z.string().default("").describe("A short name for the check"),
        command: z.string().default("").describe("A command someone could run to check the result. Nivra never runs it. At most 500 characters"),
        expectedOutput: z.string().default("").describe("What the command should print once the work is done, or empty if you don't know. At most 500 characters"),
        expectedExitCode: z.union([z.number(), z.string(), z.null()]).default(null).describe("The exit code it should give, usually 0; null if you don't know"),
        reason: z.string().default("").describe("What it would show. At most 300 characters"),
      }),
    )
    .default([])
    .describe("At most 2 checks you suggest. They are suggestions only: never say one ran or passed"),
  unknowns: Texts.describe("What you couldn't tell from the brief and won't guess, at most 4"),
});
export type CoachAnswer = z.infer<typeof CoachAnswer>;

export const COACH_TOOL_DESCRIPTION = "Hand in your coaching of this brief: a summary, questions, proposed changes, suggested checks and unknowns. Call this once.";

/** What the engine keeps of an answer, the counts of what it set aside, and how the answer went. */
export interface NormalisedCoaching {
  summary: string;
  questions: CoachQuestion[];
  changes: CoachChange[];
  suggestedChecks: CoachSuggestedCheck[];
  unknowns: string[];
  dropped: CoachDropped;
  /** Field paths and rules only, never what the answer said. */
  problems: string[];
  /** `complete` kept something; `unusable` handed in something and kept none of it; `empty` handed in nothing. */
  outcome: "complete" | "unusable" | "empty";
}

const L = COACH_REPORT_LIMITS;
const ids = (value: string | string[]): string[] => (Array.isArray(value) ? value : value.split(/[,;\s]+/)).map((item) => item.trim()).filter(Boolean);
const texts = (value: string | string[]): string[] => (Array.isArray(value) ? value : value.split(/\r?\n/)).map((item) => item.trim()).filter(Boolean);
/** A field as a model may write it: any case, with spaces, hyphens or underscores. */
const squash = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");
const QUESTION_FIELDS = new Map(CoachQuestionField.options.map((field) => [squash(field), field] as const));
const CHANGE_FIELDS = new Map(CoachField.options.map((field) => [squash(field), field] as const));

/** Control characters other than line breaks and tabs never reach the report, and a lone surrogate becomes U+FFFD. */
const plain = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    .trim();

/**
 * The coach's answer as the engine keeps it. `packet` says what its references and rewordings may name: the gaps, the
 * criteria and the assumptions by number, the mission only when it was sent, and each finding sent.
 */
export function normaliseCoaching(answer: CoachAnswer, packet: CoachPacket, mask: Mask): NormalisedCoaching {
  const dropped: CoachDropped = { questions: 0, changes: 0, items: 0, refs: 0, checks: 0, unknowns: 0 };
  const problems: string[] = [];
  const problem = (text: string) => {
    if (problems.length < L.problems) problems.push(text.slice(0, L.problemChars));
  };
  /** Prose the person reads, clipped at its limit and said so: it is shown, never accepted into the brief. */
  const prose = (text: string, max: number, path: string): string => {
    const clean = mask(plain(text));
    if (clean.length <= max) return clean;
    problem(`${path}: longer than ${max.toLocaleString("en")} characters, shortened`);
    return `${clean.slice(0, max - 1)}…`;
  };
  /** A value the person may accept into the brief: masked, and whether masking changed it. Never clipped. */
  const value = (text: string): { text: string; masked: boolean } => {
    const clean = plain(text);
    const masked = mask(clean);
    return { text: masked, masked: masked !== clean };
  };
  const refsOf = (raw: string | string[], path: string): string[] => {
    const kept: string[] = [];
    for (const given of ids(raw)) {
      const ref = given.replace(/^\[|\]$/g, "").toUpperCase();
      const match = /^([GCAF])([1-9]\d{0,2})$/.exec(ref);
      const n = match ? Number(match[2]) : 0;
      const known =
        ref === "M"
          ? packet.mission !== null
          : match?.[1] === "G"
            ? n <= packet.gaps.length
            : match?.[1] === "C"
              ? n <= packet.task.acceptanceCriteria.length
              : match?.[1] === "A"
                ? n <= packet.task.assumptions.length
                : match?.[1] === "F"
                  ? n <= packet.findings.length
                  : false;
      if (!known || kept.includes(ref) || kept.length >= L.refs) {
        dropped.refs++;
        problem(`${path}: a reference that names nothing in the packet, repeats or is past the ${L.refs} allowed was set aside`);
        continue;
      }
      kept.push(ref);
    }
    return kept;
  };

  const summary = prose(answer.summary, L.summaryChars, "summary");

  const questions: CoachQuestion[] = [];
  answer.questions.forEach((raw, index) => {
    const path = `questions[${index}]`;
    const field = QUESTION_FIELDS.get(squash(raw.field));
    const text = mask(plain(raw.text));
    if (!text && !raw.why.trim() && !raw.field.trim()) return;
    if (!field) {
      dropped.questions++;
      problem(`${path}.field: not a field the person can update`);
      return;
    }
    if (!text || text.length > L.questionChars) {
      dropped.questions++;
      problem(`${path}.text: ${text ? `longer than ${L.questionChars} characters` : "empty"}`);
      return;
    }
    if (questions.length >= L.questions) {
      dropped.questions++;
      problem(`${path}: past the ${L.questions} questions allowed`);
      return;
    }
    questions.push({ id: `Q${questions.length + 1}` as CoachQuestion["id"], text, why: prose(raw.why, L.whyChars, `${path}.why`), field });
  });

  const changes: CoachChange[] = [];
  const seen = new Set<CoachField>();
  answer.changes.forEach((raw, index) => {
    const path = `changes[${index}]`;
    const addItems = texts(raw.add);
    const empty = !raw.field.trim() && !raw.text.trim() && !raw.append.trim() && addItems.length === 0 && raw.reword.length === 0;
    if (empty) return;
    const field = CHANGE_FIELDS.get(squash(raw.field));
    const reject = (why: string) => {
      dropped.changes++;
      problem(`${path}: ${why}`);
    };
    if (!field) return reject("not a field the coach may change");
    if (seen.has(field)) return reject(`a second change to ${field}`);
    const about = { reason: prose(raw.reason, L.reasonChars, `${path}.reason`), refs: refsOf(raw.refs, `${path}.refs`) };
    if (field === "goal" || field === "scope" || field === "exclusions") {
      if (raw.append.trim() || addItems.length || raw.reword.length) return reject(`${field} takes its whole new text only`);
      const given = value(raw.text);
      if (!given.text) return reject(`${field} has no new text`);
      if (given.text.length > L.textChars) return reject(`the new ${field} is longer than ${L.textChars.toLocaleString("en")} characters`);
      seen.add(field);
      changes.push({ field, text: given.text, ...about, usable: !given.masked });
      return;
    }
    if (field === "context") {
      if (raw.text.trim() || addItems.length || raw.reword.length) return reject("context takes words to add at its end only");
      const given = value(raw.append);
      if (!given.text) return reject("context has nothing to add");
      if (given.text.length > L.appendChars) return reject(`the addition to the context is longer than ${L.appendChars.toLocaleString("en")} characters`);
      seen.add(field);
      changes.push({ field, append: given.text, ...about, usable: !given.masked });
      return;
    }
    // The criteria or the assumptions: items added, and items reworded by the number the packet gave them.
    if (raw.text.trim() || raw.append.trim()) return reject(`${field} takes items to add and items to reword only`);
    const count = field === "acceptanceCriteria" ? packet.task.acceptanceCriteria.length : packet.task.assumptions.length;
    let masked = false;
    const add: string[] = [];
    addItems.forEach((item, itemIndex) => {
      const given = value(item);
      if (!given.text || given.text.length > L.itemChars || add.length >= L.items) {
        dropped.items++;
        problem(`${path}.add[${itemIndex}]: ${!given.text ? "empty" : given.text.length > L.itemChars ? `longer than ${L.itemChars} characters` : `past the ${L.items} allowed`}`);
        return;
      }
      masked ||= given.masked;
      add.push(given.text);
    });
    const reword: Array<{ item: number; text: string }> = [];
    // An item is named by its number, bare or with this list's own letter: C for a criterion, A for an assumption. The
    // other list's letter names an item of the other list, so it is set aside, never read as this list's.
    const own = field === "acceptanceCriteria" ? "C" : "A";
    raw.reword.forEach((entry, itemIndex) => {
      const named = typeof entry.item === "number" ? null : /^([CA]?)(\d+)$/i.exec(String(entry.item).trim());
      const letter = named?.[1]?.toUpperCase() ?? "";
      const number = typeof entry.item === "number" ? entry.item : Number(named?.[2] ?? Number.NaN);
      if (letter !== "" && letter !== own) {
        dropped.items++;
        problem(`${path}.reword[${itemIndex}]: names ${letter}${String(number)}, ${letter === "C" ? "a criterion" : "an assumption"}, in a change to the ${own === "C" ? "criteria" : "assumptions"}`);
        return;
      }
      const given = value(entry.text);
      const fault = !Number.isInteger(number) || number < 1 || number > count
        ? `names an item the packet doesn't have (it has ${count})`
        : reword.some((kept) => kept.item === number)
          ? `rewords item ${number} twice`
          : !given.text
            ? "has no new wording"
            : given.text.length > L.itemChars
              ? `is longer than ${L.itemChars} characters`
              : reword.length >= L.rewords
                ? `is past the ${L.rewords} allowed`
                : null;
      if (fault) {
        dropped.items++;
        problem(`${path}.reword[${itemIndex}]: ${fault}`);
        return;
      }
      masked ||= given.masked;
      reword.push({ item: number, text: given.text });
    });
    if (add.length === 0 && reword.length === 0) return reject(`${field} has nothing left to add or reword`);
    seen.add(field);
    changes.push({ field, add, reword, ...about, usable: !masked });
  });

  const suggestedChecks: CoachSuggestedCheck[] = [];
  answer.suggestedChecks.forEach((raw, index) => {
    const path = `suggestedChecks[${index}]`;
    const name = mask(plain(raw.name));
    const command = mask(plain(raw.command));
    const expectedOutput = mask(plain(raw.expectedOutput));
    if (!name && !command && !expectedOutput) return;
    const code = typeof raw.expectedExitCode === "number" ? raw.expectedExitCode : raw.expectedExitCode === null || raw.expectedExitCode.trim() === "" ? null : Number(raw.expectedExitCode.trim());
    const fault = !name
      ? "has no name"
      : name.length > L.checkNameChars
        ? `name is longer than ${L.checkNameChars} characters`
        : !command
          ? "has no command"
          : command.length > L.commandChars
            ? `command is longer than ${L.commandChars} characters`
            : expectedOutput.length > L.outputChars
              ? `expected output is longer than ${L.outputChars} characters`
              : code !== null && (!Number.isInteger(code) || code < 0 || code > 255)
                ? "exit code isn't one from 0 to 255"
                : suggestedChecks.length >= L.checks
                  ? `is past the ${L.checks} allowed`
                  : null;
    if (fault) {
      dropped.checks++;
      problem(`${path}: ${fault}`);
      return;
    }
    suggestedChecks.push({ name, command, expectedOutput, expectedExitCode: code, reason: prose(raw.reason, L.reasonChars, `${path}.reason`) });
  });

  const unknowns: string[] = [];
  texts(answer.unknowns).forEach((raw, index) => {
    if (unknowns.length >= L.unknowns) {
      dropped.unknowns++;
      problem(`unknowns[${index}]: past the ${L.unknowns} allowed`);
      return;
    }
    const text = prose(raw, L.unknownChars, `unknowns[${index}]`);
    if (text) unknowns.push(text);
  });

  // Rejected output is never a clean answer: questions, changes or checks handed in and all set aside make it unusable,
  // whatever the summary says. A summary alone, with nothing set aside, is a complete answer that proposes nothing.
  const handedIn = answer.questions.length + answer.changes.length + answer.suggestedChecks.length;
  const kept = questions.length + changes.length + suggestedChecks.length;
  const setAside = Object.values(dropped).reduce((sum, n) => sum + n, 0);
  const outcome: NormalisedCoaching["outcome"] = handedIn > 0 && kept === 0 && setAside > 0 ? "unusable" : summary || kept > 0 || unknowns.length > 0 ? "complete" : setAside > 0 ? "unusable" : "empty";
  return { summary, questions, changes, suggestedChecks, unknowns, dropped, problems, outcome };
}

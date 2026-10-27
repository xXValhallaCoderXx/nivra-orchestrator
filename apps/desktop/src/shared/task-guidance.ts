import type { BriefContent } from "./ipc.ts";

/**
 * What a task's brief may be missing, worked out without a model (NIV-53). Each gap names its field, says why it
 * matters and how to fill it in. It is proportional: every gap a task needs is shown, but at most three that could
 * help, so a small clear task isn't put through a questionnaire, and nothing is scored. Finding no gap claims only that
 * these rules found nothing ("No basic gaps detected"), never that the brief is complete or correct. A repository, a
 * baseline or an environment is never asked for: a greenfield task can be refined without one. Pure, with no domain
 * runtime import, so the window can use it under its content security policy; the host sends its findings to the coach.
 */

export type GuidanceCode = "goal-missing" | "criteria-missing" | "rewrite" | "criterion-vague" | "current-behaviour" | "scope-missing" | "failure-case" | "many-criteria" | "no-case";

/** What the task needs now, what could help, and what only a run needs. */
export type GuidanceTier = "needed" | "could-help" | "before-run";

/** The brief's field a gap is about, as the brief names it. */
export type GuidanceField = "goal" | "acceptanceCriteria" | "scope" | "exclusions" | "context" | "assumptions" | "acceptanceCases";

export interface GuidanceItem {
  code: GuidanceCode;
  tier: GuidanceTier;
  field: GuidanceField;
  /** The criterion it is about, numbered from 1 as the brief lists them; null for a whole field. */
  item: number | null;
  /** What is missing, in Nivra's words: what the person reads, and what the coach is told. */
  missing: string;
  why: string;
  how: string;
}

export interface Guidance {
  items: GuidanceItem[];
  /** Gaps that could help beyond the ones shown, which show once those are settled. */
  held: number;
}

/** The most gaps that could help shown at once. */
export const COULD_HELP_SHOWN = 3;
/** More criteria than this suggests more than one task. */
export const MANY_CRITERIA = 8;
/** A brief this large, by its criteria or its goal's length, says what it covers and what it leaves alone. */
const LARGE = { criteria: 3, goalChars: 280 } as const;
/** A criterion this short with only vague words may be hard to check. */
const SHORT_CRITERION = 60;

export const NO_GAPS = "No basic gaps detected.";
export const NO_GAPS_DETAIL = "These checks look for common gaps only. They don't show that the brief is complete or correct.";

const VAGUE = /\b(works?|working|better|properly|correctly|correct|good|nice|clean|cleaner|fast|faster|quick|quickly|improved?|improves|robust|user[- ]friendly|intuitive|smooth|smoothly|reliable|reliably|fine|ok|okay|as expected)\b/i;
const OBSERVABLE = /\b(given|when|then|if|shows?|returns?|displays?|prints?|equals?|contains?|appears?|reads?|lists?|exactly|at least|at most|within|less than|more than|after|before)\b|[0-9"'`=<>%]/i;
const FIX = /\b(fix|fixes|fixed|bug|bugs|broken|wrong|fails?|failing|failure|errors?|crash|crashes|crashed|regression|incorrect)\b/i;
const NOW = /\b(currently|now|today|at the moment|instead|expected|actual|actually|happens?)\b/i;
const FAILURE = /\b(errors?|invalid|empty|missing|fails?|failure|rejects?|rejected|refuses?|refused|edge|limits?|boundary|zero|none|never|without|not|no)\b/i;

const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The gaps in a brief, needed ones first, then up to three that could help, then what only a run needs. */
export function taskGuidance(brief: Pick<BriefContent, "goal" | "acceptanceCriteria" | "scope" | "exclusions" | "context" | "assumptions" | "acceptanceCases" | "revalidate">): Guidance {
  const goal = brief.goal.trim();
  const criteria = brief.acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean);
  const needed: GuidanceItem[] = [];
  const couldHelp: GuidanceItem[] = [];
  const beforeRun: GuidanceItem[] = [];

  if (!goal) {
    needed.push({
      code: "goal-missing",
      tier: "needed",
      field: "goal",
      item: null,
      missing: "The goal is empty.",
      why: "Everything else in the brief, and any run of it, is checked against the goal.",
      how: "Say in a sentence or two what should be different when this is done.",
    });
  }
  if (criteria.length === 0) {
    needed.push({
      code: "criteria-missing",
      tier: "needed",
      field: "acceptanceCriteria",
      item: null,
      missing: "There is no acceptance criterion.",
      why: "A task can be marked ready only with one, and it is how you'll know the work is done.",
      how: "Write one result someone could see, one per line: an input or an action, and what should happen.",
    });
  }
  if (brief.revalidate.length > 0) {
    const parts = brief.revalidate.map((part) => (part === "context" ? "the context" : "the assumptions")).join(" and ");
    needed.push({
      code: "rewrite",
      tier: "needed",
      field: brief.revalidate.includes("context") ? "context" : "assumptions",
      item: null,
      missing: `This brief's repository changed, so ${parts} were cleared.`,
      why: "What was there came from another project's conversation, which this task no longer uses.",
      how: `Write ${parts} again for this repository.`,
    });
  }

  brief.acceptanceCriteria.forEach((raw, index) => {
    const criterion = raw.trim();
    if (!criterion || criterion.length > SHORT_CRITERION || !VAGUE.test(criterion) || OBSERVABLE.test(criterion)) return;
    couldHelp.push({
      code: "criterion-vague",
      tier: "could-help",
      field: "acceptanceCriteria",
      item: index + 1,
      missing: `Criterion ${index + 1} may be hard to check: "${clip(criterion)}"`,
      why: "Words like works, better or properly don't say what someone would see, so two people could disagree about whether it passed.",
      how: "Say what someone would see or measure: an input or an action, and the result it should give.",
    });
  });
  if (goal && FIX.test(goal) && !(brief.context.trim() && NOW.test(brief.context))) {
    couldHelp.push({
      code: "current-behaviour",
      tier: "could-help",
      field: "context",
      item: null,
      missing: "The brief doesn't say what happens now.",
      why: "For a fix, the difference between what happens now and what should happen is what the change has to close.",
      how: "In the context, say what happens today, step by step, and what should happen instead.",
    });
  }
  if (!brief.scope.trim() && !brief.exclusions.trim() && (criteria.length >= LARGE.criteria || goal.length > LARGE.goalChars)) {
    couldHelp.push({
      code: "scope-missing",
      tier: "could-help",
      field: "scope",
      item: null,
      missing: "The brief doesn't say what is in or out of scope.",
      why: "Without limits a change can keep growing, and a reviewer can't tell something left out from something decided.",
      how: "Under scope, name what the change covers; under exclusions, what it leaves alone.",
    });
  }
  if (criteria.length >= 2 && !criteria.some((criterion) => FAILURE.test(criterion))) {
    couldHelp.push({
      code: "failure-case",
      tier: "could-help",
      field: "acceptanceCriteria",
      item: null,
      missing: "No criterion says what happens when something goes wrong.",
      why: "Work that handles only the expected input can still break on the first unusual one.",
      how: "Add a criterion for bad, missing or extreme input, and what should happen then.",
    });
  }
  if (criteria.length > MANY_CRITERIA) {
    couldHelp.push({
      code: "many-criteria",
      tier: "could-help",
      field: "acceptanceCriteria",
      item: null,
      missing: `The brief has ${criteria.length} acceptance criteria.`,
      why: "That is a lot for one small task, so it may be more than one piece of work.",
      how: "Consider splitting it into tasks that can each be finished and checked on their own.",
    });
  }

  if (criteria.length > 0 && brief.acceptanceCases.length === 0) {
    beforeRun.push({
      code: "no-case",
      tier: "before-run",
      field: "acceptanceCases",
      item: null,
      missing: "There is no acceptance case yet.",
      why: "Criteria are statements for people. Nivra judges a run only by acceptance cases: a command, and exactly what it must print and the exit code it must give.",
      how: "Add one only when you want to run the task. You can refine the brief without it.",
    });
  }

  return { items: [...needed, ...couldHelp.slice(0, COULD_HELP_SHOWN), ...beforeRun], held: Math.max(0, couldHelp.length - COULD_HELP_SHOWN) };
}

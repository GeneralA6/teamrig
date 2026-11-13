import { isRecord } from '../core/guards.ts';
import { auditOf, handStepShapeOf, runFileDrift, runLineOf, shortSha256, type HandStepAudit, type RunFiles } from './hand-step.ts';

/**
 * A decision card (T514): what a task waiting on a decision or an approval asks, written so whoever decides needs
 * nothing else: the question, the options with their numbers, the recommendation, and what happens when no answer
 * comes. The task's title and description say what it is and why it matters, and an owner-facing output names
 * each task the card mentions by its title (namedTaskIds), so no task number stands alone.
 */
export interface DecisionCard {
  /** What is being decided. */
  readonly question: string;
  /** The choices, each with its numbers; at least two for a decision, none for an approval (yes or no). */
  readonly options: readonly string[];
  /** The option recommended, and why. */
  readonly recommend: string;
  /** What happens when no answer comes by the task's due date. */
  readonly byDefault: string;
  /**
   * Only on a task the owner ordered (T802): why the owner is asked at all, since an owner's order approves its own
   * work and proof unless the order must change, the work needs something new, or only the owner can see the result.
   */
  readonly whyAsk?: string;
  /**
   * Only on a wait on the owner's decision (T1194): the owner gate [ownerGates] or the business decision that makes
   * the question the owner's at all; any other question is its leader's, however many good answers it has.
   */
  readonly gate?: string;
  /**
   * Only on a wait on the owner's decision or approval (T2312, core rule 11): the hand step file the owner runs, by its
   * absolute path, which an audit on the task pins at its sha256; the card prints the line that runs it.
   */
  readonly run?: string;
}

/** The CLI flags that write a card's parts, for the refusals that name them. */
export const CARD_FLAGS = '--question, --options, --recommend and --default';

/** The CLI flag that writes a card's `whyAsk`. */
export const WHY_ASK_FLAG = '--why-ask';

/** The CLI flag that writes a card's `gate`. */
export const GATE_FLAG = '--gate';

/** The CLI flag that writes a card's `run`. */
export const RUN_FLAG = '--run';

/** The gate that names a business decision, the owner's besides the owner gates (T1194). */
export const BUSINESS_GATE = 'business';

/** The gates a card may name: each owner gate [ownerGates], then a business decision. */
export function gateChoices(ownerGates: readonly string[]): string[] {
  return [...ownerGates, BUSINESS_GATE];
}

/** How `--gate` is typed, naming each gate a card may name. */
export function gateUsage(ownerGates: readonly string[]): string {
  const choices = gateChoices(ownerGates);
  return `${GATE_FLAG} "<${choices.slice(0, -1).join(', ')} or ${BUSINESS_GATE}>"`;
}

/** The gate `typed` names, as `ownerGates` or BUSINESS_GATE spell it, case aside; undefined when it names none. */
export function gateOf(typed: string, ownerGates: readonly string[]): string | undefined {
  const key = typed.trim().toLowerCase();
  return gateChoices(ownerGates).find((choice) => choice.toLowerCase() === key);
}

/** How to say why the owner (`ownerSource`) is asked about what the owner ordered (T802). */
export function whyAskUsage(ownerSource: string): string {
  return `${WHY_ASK_FLAG} "<how the order must change, what new it needs, or why only ${ownerSource} can see the result>"`;
}

/** How `--options` separates the choices: a comma or a semicolon is common inside one. */
export const OPTION_SEPARATOR = '|';

/** How a choice says a literal OPTION_SEPARATOR inside it: `--options "keep 'a \\| b' | drop it"`. */
export const OPTION_SEPARATOR_ESCAPE = `\\${OPTION_SEPARATOR}`;

/** `--options` text as its choices, each trimmed: split at each OPTION_SEPARATOR not escaped as OPTION_SEPARATOR_ESCAPE. */
export function splitOptions(text: string): string[] {
  const options: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith(OPTION_SEPARATOR_ESCAPE, index)) {
      current += OPTION_SEPARATOR;
      index += OPTION_SEPARATOR_ESCAPE.length - 1;
    } else if (text.startsWith(OPTION_SEPARATOR, index)) {
      options.push(current.trim());
      current = '';
    } else {
      current += text[index];
    }
  }
  options.push(current.trim());
  return options;
}

/** What a refusal about the choices adds: how many choices --options split into, each shown, and the escape for a literal separator. */
export function optionsSplitText(options: readonly string[]): string {
  const shown = options.map((option) => `"${option}"`).join(' / ');
  return `--options split into ${options.length} choice${options.length === 1 ? '' : 's'} at each ${OPTION_SEPARATOR}: ${shown}; write ${OPTION_SEPARATOR_ESCAPE} for a ${OPTION_SEPARATOR} inside a choice`;
}

/** How a refusal names one choice of `--options`, before its number. */
const OPTION_CHOICE_PART = '--options choice ';

/** The fewest plain words each part of a card says; task ids do not count. */
export const CARD_MIN_WORDS = 3;

/** The fewest options a decision lists; an approval asks yes or no and may list none. */
export const MIN_DECISION_OPTIONS = 2;

/** A task id standing as a word: `T378`, `(T378)`, `T378,`. */
const TASK_WORD = /\bT[1-9]\d*\b/g;

/**
 * The card's parts as one list of texts, in the order a card prints them, but its run file: a path is no prose, and
 * a task id in it (`tasks/T5/step.ps1`) names no task the card is about.
 */
export function cardTexts(card: DecisionCard): string[] {
  return [
    card.question,
    ...(card.gate === undefined ? [] : [card.gate]),
    ...(card.whyAsk === undefined ? [] : [card.whyAsk]),
    ...card.options,
    card.recommend,
    card.byDefault,
  ];
}

/** Which of a card's owner parts still hold: `whyAsk`, `gate` and `run` each go once what they answer no longer applies. */
export interface KeptOwnerParts {
  /** The task is one the owner ordered and waits on the owner's decision or approval (T802). */
  readonly whyAsk: boolean;
  /** The task waits on the owner's decision (T1194). */
  readonly gate: boolean;
  /** The task waits on the owner's decision or approval, so a hand step still goes to the owner (T2312). */
  readonly run: boolean;
}

/** The card with only the owner parts that still hold (`keep`). */
export function keptCard(card: DecisionCard, keep: KeptOwnerParts): DecisionCard {
  return {
    question: card.question,
    options: card.options,
    recommend: card.recommend,
    byDefault: card.byDefault,
    ...(keep.whyAsk && card.whyAsk !== undefined ? { whyAsk: card.whyAsk } : {}),
    ...(keep.gate && card.gate !== undefined ? { gate: card.gate } : {}),
    ...(keep.run && card.run !== undefined ? { run: card.run } : {}),
  };
}

/** How many words a text says besides task ids: letters and digits in runs, so `30 days: 4 GB` is four. */
export function plainWords(text: string): number {
  return text
    .replace(TASK_WORD, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '').length;
}

/** Every task id the texts name, in the order first named, each once. */
export function namedTaskIds(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => text.match(TASK_WORD) ?? []))];
}

/**
 * Why a card cannot be written, or undefined: every part says at least CARD_MIN_WORDS plain words, so a bare
 * task number (`option B of T378`) is refused; a decision lists at least MIN_DECISION_OPTIONS options, and an
 * approval none or as many.
 */
export function cardProblem(card: DecisionCard, decision: boolean): string | undefined {
  const thin = typedParts(card).find(([, text]) => plainWords(text) < CARD_MIN_WORDS);
  if (thin !== undefined) {
    const split = thin[0].startsWith(OPTION_CHOICE_PART) ? `; ${optionsSplitText(card.options)}` : '';
    return `${thin[0]} says "${thin[1]}": give at least ${CARD_MIN_WORDS} plain words besides task ids, so it reads without the task list${split}`;
  }
  if (card.options.length === 1 || (decision && card.options.length < MIN_DECISION_OPTIONS)) {
    return `--options lists ${card.options.length}: a decision lists at least ${MIN_DECISION_OPTIONS}, separated by ${OPTION_SEPARATOR}${decision ? '' : '; an approval lists none or as many'}${card.options.length === 0 ? '' : `; ${optionsSplitText(card.options)}`}`;
  }
  return undefined;
}

/**
 * The parts of a card its writer types, each with the flag that wrote it, for the refusals that name one: the
 * question, why asked, each option, the recommendation and the default. The gate is left out, as it is one of the
 * names the config gives, and the run file, as it is a path.
 */
function typedParts(card: DecisionCard): readonly (readonly [string, string])[] {
  return [
    ['--question', card.question],
    ...(card.whyAsk === undefined ? [] : [[WHY_ASK_FLAG, card.whyAsk] satisfies [string, string]]),
    ...card.options.map((option, index): [string, string] => [`${OPTION_CHOICE_PART}${index + 1}`, option]),
    ['--recommend', card.recommend],
    ['--default', card.byDefault],
  ];
}

/** A card part that hands the human a hand step in its text (T2312, core rule 11): the flag that wrote it, and the step's shape in words. */
export interface TypedHandStep {
  readonly flag: string;
  readonly shape: string;
}

/**
 * The first typed part of a card that holds a hand step in its text, code or an ask to paste (handStepShapeOf);
 * undefined when none does. A card that hands its step as a run file is not asked, as the run line is where the
 * step is, and its text may name it.
 */
export function typedHandStep(card: DecisionCard): TypedHandStep | undefined {
  if (card.run !== undefined) {
    return undefined;
  }
  for (const [flag, text] of typedParts(card)) {
    const shape = handStepShapeOf(text);
    if (shape !== undefined) {
      return { flag, shape };
    }
  }
  return undefined;
}

/** True when both cards say the same, so setting one again changes nothing. */
export function sameCard(a: DecisionCard | null, b: DecisionCard | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.question === b.question &&
    a.recommend === b.recommend &&
    a.byDefault === b.byDefault &&
    a.whyAsk === b.whyAsk &&
    a.gate === b.gate &&
    a.run === b.run &&
    a.options.length === b.options.length &&
    a.options.every((option, index) => option === b.options[index])
  );
}

/**
 * A status line's card: undefined when absent or null, else its parts, or the reason it is not a card. Parsing
 * checks the format only; what a card must say is judged on write (cardProblem).
 */
export function parseCard(value: unknown): DecisionCard | undefined | string {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    return 'card is not an object';
  }
  const { question, options, recommend, byDefault, whyAsk, gate, run } = value;
  if (typeof question !== 'string' || typeof recommend !== 'string' || typeof byDefault !== 'string') {
    return 'card needs question, recommend and byDefault as text';
  }
  if (!Array.isArray(options) || !options.every((option): option is string => typeof option === 'string')) {
    return 'card options is not a list of texts';
  }
  if (whyAsk !== undefined && typeof whyAsk !== 'string') {
    return 'card whyAsk is not text';
  }
  if (gate !== undefined && typeof gate !== 'string') {
    return 'card gate is not text';
  }
  if (run !== undefined && typeof run !== 'string') {
    return 'card run is not text';
  }
  return {
    question,
    options,
    recommend,
    byDefault,
    ...(whyAsk === undefined ? {} : { whyAsk }),
    ...(gate === undefined ? {} : { gate }),
    ...(run === undefined ? {} : { run }),
  };
}

/**
 * A card as printed under its task: the question, the owner gate or business reason that makes it the owner's and
 * why the owner is asked (when the card says), each option numbered, the recommendation and the default, then the
 * hand step to run (when the card hands one), each line led by `indent`. `audits` are the task's (fold.ts), and
 * `runFiles` what its hand step file hashes to now.
 */
export function cardLines(card: DecisionCard, indent: string, audits: readonly HandStepAudit[], runFiles: RunFiles): string[] {
  return [
    `${indent}decide: ${card.question}`,
    ...(card.gate === undefined ? [] : [`${indent}gate: ${card.gate}`]),
    ...(card.whyAsk === undefined ? [] : [`${indent}why asked: ${card.whyAsk}`]),
    ...card.options.map((option, index) => `${indent}  ${index + 1}. ${option}`),
    `${indent}recommended: ${card.recommend}`,
    `${indent}with no answer: ${card.byDefault}`,
    ...(card.run === undefined ? [] : [`${indent}run: ${runText(card.run, audits, runFiles)}`]),
  ];
}

/**
 * How the owner runs a card's hand step file, with the sha256 its audit pins and who audited it, so the owner can
 * match the file; that it is not to be run with no audit of it on the task (a register line written by hand), or
 * once the file changed or went since its audit (runFileDrift), until it is audited again.
 */
function runText(run: string, audits: readonly HandStepAudit[], runFiles: RunFiles): string {
  const audit = auditOf(audits, run);
  const line = runLineOf(run);
  if (audit === undefined || line === undefined) {
    return `do not run ${run}: no audit on the task pins it (core rule 11)`;
  }
  const drift = runFileDrift(audit, runFiles);
  return drift === undefined ? `${line}   (sha256 ${shortSha256(audit.sha256)}, audited by ${audit.by})` : `${drift}: do not run ${run}; audit it again`;
}

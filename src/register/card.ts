import { isRecord } from '../core/guards.ts';

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
}

/** The CLI flags that write a card's parts, for the refusals that name them. */
export const CARD_FLAGS = '--question, --options, --recommend and --default';

/** How `--options` separates the choices: a comma or a semicolon is common inside one. */
export const OPTION_SEPARATOR = '|';

/** The fewest plain words each part of a card says; task ids do not count. */
export const CARD_MIN_WORDS = 3;

/** The fewest options a decision lists; an approval asks yes or no and may list none. */
export const MIN_DECISION_OPTIONS = 2;

/** A task id standing as a word: `T378`, `(T378)`, `T378,`. */
const TASK_WORD = /\bT[1-9]\d*\b/g;

/** The card's parts as one list of texts, in the order a card prints them. */
export function cardTexts(card: DecisionCard): string[] {
  return [card.question, ...card.options, card.recommend, card.byDefault];
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
  const parts: readonly [string, string][] = [
    ['--question', card.question],
    ...card.options.map((option, index): [string, string] => [`--options choice ${index + 1}`, option]),
    ['--recommend', card.recommend],
    ['--default', card.byDefault],
  ];
  const thin = parts.find(([, text]) => plainWords(text) < CARD_MIN_WORDS);
  if (thin !== undefined) {
    return `${thin[0]} says "${thin[1]}": give at least ${CARD_MIN_WORDS} plain words besides task ids, so it reads without the task list`;
  }
  if (card.options.length === 1 || (decision && card.options.length < MIN_DECISION_OPTIONS)) {
    return `--options lists ${card.options.length}: a decision lists at least ${MIN_DECISION_OPTIONS}, separated by ${OPTION_SEPARATOR}${decision ? '' : '; an approval lists none or as many'}`;
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
  const { question, options, recommend, byDefault } = value;
  if (typeof question !== 'string' || typeof recommend !== 'string' || typeof byDefault !== 'string') {
    return 'card needs question, recommend and byDefault as text';
  }
  if (!Array.isArray(options) || !options.every((option): option is string => typeof option === 'string')) {
    return 'card options is not a list of texts';
  }
  return { question, options, recommend, byDefault };
}

/** A card as printed under its task: the question, each option numbered, the recommendation and the default, each line led by `indent`. */
export function cardLines(card: DecisionCard, indent: string): string[] {
  return [
    `${indent}decide: ${card.question}`,
    ...card.options.map((option, index) => `${indent}  ${index + 1}. ${option}`),
    `${indent}recommended: ${card.recommend}`,
    `${indent}with no answer: ${card.byDefault}`,
  ];
}

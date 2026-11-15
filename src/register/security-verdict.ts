import { isRecord } from '../core/guards.ts';
import type { DecisionCard } from './card.ts';

// No node: import here: the fold and the views reach this file, and the read entry (src/read) runs without Node's
// built-ins. That is also why a verdict binds to its card by a copy of the parts it read, not their sha256: a copy
// binds exactly as a hash would, and comparing it needs no crypto module.

/**
 * The parts of a decision card a security verdict was given on (T2761): what is decided, the options and the
 * recommendation. A card whose parts differ from these is not the card the reviewer read. Its default, gate and
 * why-ask are left out: they say when and why the owner is asked, not what the owner approves, and a why-ask is
 * written only on the owner's wait, after the verdict, so it would stale every verdict.
 */
export interface VerdictRead {
  readonly question: string;
  readonly options: readonly string[];
  readonly recommend: string;
}

/** What a verdict update pins: the reviewer's verdict, and the card parts it was given on. */
export interface SecurityVerdictPin {
  readonly text: string;
  readonly read: VerdictRead;
}

/** A verdict as its task keeps it: the pin, the session that gave it, and when. */
export interface SecurityVerdict extends SecurityVerdictPin {
  readonly by: string;
  readonly at: string;
}

/** The parts of `card` a verdict reads. */
export function verdictReadOf(card: DecisionCard): VerdictRead {
  return { question: card.question, options: [...card.options], recommend: card.recommend };
}

/** True when `card` still asks what `verdict` was given on: the same question, options in order and recommendation. */
export function verdictIsCurrent(verdict: SecurityVerdictPin, card: DecisionCard): boolean {
  const { read } = verdict;
  return (
    read.question === card.question &&
    read.recommend === card.recommend &&
    read.options.length === card.options.length &&
    read.options.every((option, index) => option === card.options[index])
  );
}

/** The verdict pin an update line gives, or why it is not one. */
export function parseSecurityVerdictPin(value: unknown): SecurityVerdictPin | string {
  if (!isRecord(value) || typeof value['text'] !== 'string' || value['text'].trim() === '') {
    return `bad security verdict ${JSON.stringify(value)}`;
  }
  const read = value['read'];
  if (!isRecord(read)) {
    return `bad security verdict ${JSON.stringify(value)}`;
  }
  const { question, options, recommend } = read;
  if (typeof question !== 'string' || typeof recommend !== 'string' || !Array.isArray(options) || !options.every((option): option is string => typeof option === 'string')) {
    return `bad security verdict ${JSON.stringify(value)}`;
  }
  return { text: value['text'], read: { question, options, recommend } };
}

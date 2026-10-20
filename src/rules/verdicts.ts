import type { Files } from '../core/files.ts';
import { isRecord, stringField } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { lineHash } from '../inbox/line-hash.ts';
import { CORE_RULE_KEYS, isCoreRuleKey, type CoreRuleKey } from './keys.ts';
import type { Candidate } from './scan.ts';

/**
 * The candidate lines of `rules scan` the lead recorded as not conflicting with a core rule (`rules clear`), so a
 * rescan lists only new or changed lines for the model to judge. A verdict is kept by its line's text hash, with the
 * hash of each core rule's text it was judged against, so it lapses when the line or one of those rules changes.
 * One small file per team (`state/rule-verdicts.json`), written only by `rules clear`.
 */

/** The format of the verdicts file this code reads and writes; a file in another format reads as no verdicts. */
export const VERDICTS_FORMAT = 1;

/** Each core rule's text hash (`lineHash` of its `coreRuleTexts` text). */
export type RuleHashes = ReadonlyMap<CoreRuleKey, string>;

/** A candidate line judged not to conflict with the core rules it touches. */
export interface ClearedLine {
  /** `lineHash` of the line's text. */
  readonly text: string;
  /** The text hash, when it was judged, of each core rule it was judged against (`rulesJudged`). */
  readonly rules: RuleHashes;
  /** The UTC day it was recorded, `2026-10-19`. */
  readonly day: string;
}

export function ruleHashesOf(texts: Readonly<Record<CoreRuleKey, string>>): RuleHashes {
  return new Map<CoreRuleKey, string>(CORE_RULE_KEYS.map((key) => [key, lineHash(texts[key])]));
}

/**
 * The core rules a candidate is judged against: those its words name, or every rule for a line that names none (a
 * line tagged only `precedence` or `teamrig` speaks to the core rules as a whole).
 */
export function rulesJudged(candidate: Candidate): readonly CoreRuleKey[] {
  return candidate.topics.rules.length === 0 ? CORE_RULE_KEYS : candidate.topics.rules;
}

/** The verdicts by their line's text hash, for `isCleared`. */
export function verdictsByText(verdicts: readonly ClearedLine[]): ReadonlyMap<string, ClearedLine> {
  return new Map<string, ClearedLine>(verdicts.map((verdict) => [verdict.text, verdict]));
}

/** True when a verdict clears the candidate still: its text is the one judged, and so is each rule it is judged against. */
export function isCleared(candidate: Candidate, byText: ReadonlyMap<string, ClearedLine>, hashes: RuleHashes): boolean {
  const verdict = byText.get(lineHash(candidate.text));
  return verdict !== undefined && rulesJudged(candidate).every((key) => verdict.rules.get(key) === hashes.get(key));
}

function verdictOf(candidate: Candidate, hashes: RuleHashes, day: string): ClearedLine {
  const rules = new Map<CoreRuleKey, string>();
  for (const key of rulesJudged(candidate)) {
    const hash = hashes.get(key);
    if (hash !== undefined) {
      rules.set(key, hash);
    }
  }
  return { text: lineHash(candidate.text), rules, day };
}

/**
 * The verdicts to store once `cleared` is judged: those, and each earlier verdict that still clears a candidate line
 * there now. A verdict whose line is gone, changed or now judged against a changed rule is dropped, so the file holds
 * at most one verdict per candidate line.
 */
export function nextVerdicts(
  previous: readonly ClearedLine[],
  candidates: readonly Candidate[],
  cleared: readonly Candidate[],
  hashes: RuleHashes,
  day: string,
): ClearedLine[] {
  const fresh = verdictsByText(cleared.map((candidate) => verdictOf(candidate, hashes, day)));
  const byText = verdictsByText(previous);
  const held = new Set(candidates.filter((candidate) => isCleared(candidate, byText, hashes)).map((candidate) => lineHash(candidate.text)));
  return [...previous.filter((verdict) => held.has(verdict.text) && !fresh.has(verdict.text)), ...fresh.values()];
}

function clearedLineOf(value: unknown): ClearedLine[] {
  if (!isRecord(value)) {
    return [];
  }
  const text = stringField(value, 'text');
  const day = stringField(value, 'day');
  const judged = value['rules'];
  if (text === undefined || day === undefined || !isRecord(judged)) {
    return [];
  }
  const rules = new Map<CoreRuleKey, string>();
  for (const [key, hash] of Object.entries(judged)) {
    if (isCoreRuleKey(key) && typeof hash === 'string') {
      rules.set(key, hash);
    }
  }
  return rules.size === 0 ? [] : [{ text, rules, day }];
}

/** A verdicts file's content; none when it is damaged or from another format, so every candidate is judged again. */
export function parseVerdicts(text: string): ClearedLine[] {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== VERDICTS_FORMAT) {
    return [];
  }
  const cleared = record['cleared'];
  return Array.isArray(cleared) ? cleared.flatMap(clearedLineOf) : [];
}

export function formatVerdicts(verdicts: readonly ClearedLine[]): string {
  return toJsonlLine({
    [VERSION_FIELD]: VERDICTS_FORMAT,
    cleared: verdicts.map((verdict) => ({ text: verdict.text, rules: Object.fromEntries(verdict.rules), day: verdict.day })),
  });
}

/** The team's verdicts, one small JSON file. */
export class VerdictStore {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  /** The stored verdicts; none when there is no file yet or it is damaged. */
  async read(): Promise<ClearedLine[]> {
    const text = await this.files.read(this.path);
    return text === undefined ? [] : parseVerdicts(text);
  }

  async write(verdicts: readonly ClearedLine[]): Promise<void> {
    await this.files.write(this.path, formatVerdicts(verdicts));
  }
}

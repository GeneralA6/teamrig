import { isRecord, recordField } from '../lib/guards.ts';

/**
 * The provider-word check of the skills (docs/design/provider-neutral-skills.md): how often a skill names one host's
 * or tool's own words, counted so the count can only fall. A skill tells the step (open a pull request, refresh the
 * context); the adapter that serves the host or tool says how. The terms live here until the declarations carry them
 * (stopgap T4860 slice 3).
 */

/** One file of a skill: the skill's folder and the file's path, both from the repo root with `/`, and its text. */
export interface SkillFile {
  readonly skill: string;
  readonly path: string;
  readonly text: string;
}

/** Each provider's own words. A term matches whole words at its word-character edges, so `gh` never hits `high`. */
export const PROVIDER_TERMS = [
  { provider: 'GitHub', terms: ['GitHub', 'gh', 'pull request'] },
  { provider: 'Claude Code', terms: ['Claude Code', 'CLAUDE.md', '.claude/', '/clear'] },
  { provider: 'Jira', terms: ['Jira', 'JQL'] },
] as const;

export interface ProviderHit {
  readonly skill: string;
  readonly path: string;
  /** From 1. */
  readonly line: number;
  /** The term as the list spells it, not as the line does. */
  readonly term: string;
}

const WORD_CHAR = /\w/;

/** A term's pattern: case-blind, with a word bound at each edge that is a word character. */
export function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const start = WORD_CHAR.test(term.charAt(0)) ? '\\b' : '';
  const end = WORD_CHAR.test(term.charAt(term.length - 1)) ? '\\b' : '';
  return new RegExp(`${start}${escaped}${end}`, 'gi');
}

const PATTERNS: readonly { readonly term: string; readonly pattern: RegExp }[] = PROVIDER_TERMS.flatMap(({ terms }) => terms.map((term) => ({ term, pattern: termPattern(term) })));

/** Every term a file names, one hit per match, by line and then in the terms' order. */
export function providerHits(files: readonly SkillFile[]): readonly ProviderHit[] {
  return files.flatMap((file) =>
    file.text.split('\n').flatMap((text, index) => PATTERNS.flatMap(({ term, pattern }) => [...text.matchAll(pattern)].map(() => ({ skill: file.skill, path: file.path, line: index + 1, term })))),
  );
}

/** How many hits each skill has, every skill of the files listed (a skill with none at 0), sorted by its folder. */
export function skillCounts(files: readonly SkillFile[]): ReadonlyMap<string, number> {
  const hits = providerHits(files);
  const skills = [...new Set(files.map((file) => file.skill))].sort();
  return new Map(skills.map((skill) => [skill, hits.filter((hit) => hit.skill === skill).length]));
}

/** What the counts did against the baseline. A skill the baseline lacks has a baseline of 0. */
export interface CountChange {
  readonly skill: string;
  readonly count: number;
  readonly baseline: number;
}

export interface Comparison {
  /** Counts above their baseline: the check fails on each. */
  readonly rose: readonly CountChange[];
  /** Counts below their baseline: `--write` lowers it. */
  readonly fell: readonly CountChange[];
  /** Baseline entries of skills no longer there. */
  readonly gone: readonly string[];
}

export function compareCounts(counts: ReadonlyMap<string, number>, baseline: ReadonlyMap<string, number>): Comparison {
  const changes = [...counts].map(([skill, count]) => ({ skill, count, baseline: baseline.get(skill) ?? 0 }));
  return {
    rose: changes.filter((change) => change.count > change.baseline),
    fell: changes.filter((change) => change.count < change.baseline),
    gone: [...baseline.keys()].filter((skill) => !counts.has(skill)).sort(),
  };
}

const BASELINE_COMMENT =
  'The provider-word check (tools/ci/provider-words-cli.ts): how many host or tool words each skill names. A count may fall, never rise; `--write` records the counts and refuses a rise.';

/** The baseline file's skill counts; throws on anything but `{ skills: { <folder>: <whole count> } }`. */
export function parseBaseline(value: unknown): ReadonlyMap<string, number> {
  const skills = isRecord(value) ? recordField(value, 'skills') : undefined;
  if (skills === undefined) throw new Error('the baseline needs a "skills" object');
  return new Map(
    Object.entries(skills).map(([skill, count]) => {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new Error(`the baseline count of ${skill} is not a whole number`);
      return [skill, count];
    }),
  );
}

/** The baseline file's text for these counts, skills sorted, so each OS writes the same bytes. */
export function baselineText(counts: ReadonlyMap<string, number>): string {
  const skills = Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ $comment: BASELINE_COMMENT, skills }, null, 2)}\n`;
}

export function hitLine(hit: ProviderHit): string {
  return `${hit.path}:${hit.line}: ${hit.term}`;
}

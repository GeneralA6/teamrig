import type { RuleConflict } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { isRecord } from '../core/guards.ts';
import type { PathProbe } from '../core/path-probe.ts';
import { expandHome, pathKey } from '../core/paths.ts';
import { jsonObjectOf } from '../doctor/settings-env.ts';
import { findRulePlaces, type RulePlace, type RulePlaceLocations } from './places.ts';
import { topicsOf, type LineTopics } from './topics.ts';

/** A line of a place that can hold a rule, numbered from 1 as an editor numbers it, its text trimmed. */
export interface RuleLine {
  readonly line: number;
  readonly text: string;
}

/** Every string below `value`, depth first in the order written. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  return isRecord(value) ? Object.values(value).flatMap(stringsIn) : [];
}

/** The 1-based line of the character at `index`. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * The `autoMode` lines of a settings file, each at the line it is written on: the text the auto-mode check reads beside
 * the session's rules. The rest of a settings file holds no rule, and its `env` block may hold secrets, so it is never read out.
 */
function autoModeLines(raw: string): RuleLine[] {
  const settings = jsonObjectOf(raw);
  const autoMode = settings?.['autoMode'];
  if (autoMode === undefined) {
    return [];
  }
  const start = Math.max(0, raw.indexOf('"autoMode"'));
  let from = start;
  return stringsIn(autoMode).map((text) => {
    const found = raw.indexOf(JSON.stringify(text), from);
    from = found === -1 ? from : found + 1;
    return { line: lineAt(raw, found === -1 ? start : found), text: text.trim() };
  });
}

/** The lines of a file that can hold a rule: the `autoMode` lines of a settings (`.json`) file, every line of any other. */
export function ruleLinesOf(path: string, raw: string): RuleLine[] {
  if (path.toLowerCase().endsWith('.json')) {
    return autoModeLines(raw);
  }
  return raw
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text: text.trim() }));
}

/** The line a recorded conflict quotes: the first whose text starts with the quote, so edits elsewhere never lose it. */
export function recordedLine(conflict: RuleConflict, lines: readonly RuleLine[]): RuleLine | undefined {
  return lines.find((line) => line.text.startsWith(conflict.text));
}

/** A line whose words touch a core rule's topic, for the model to judge whether it conflicts with that rule. */
export interface Candidate {
  readonly place: RulePlace;
  readonly line: number;
  readonly text: string;
  readonly topics: LineTopics;
}

/** A recorded conflict and the line it quotes now, undefined when the file or the line is gone. */
export interface RecordedConflict {
  readonly conflict: RuleConflict;
  readonly line: number | undefined;
}

export interface RuleScan {
  readonly places: readonly RulePlace[];
  readonly nestedCapped: boolean;
  readonly recorded: readonly RecordedConflict[];
  /** The candidate lines, in place order, leaving out the lines a recorded conflict quotes. */
  readonly candidates: readonly Candidate[];
}

/**
 * Finds every place a local rule can override a core rule (see `findRulePlaces`), the lines there whose words touch a
 * core rule's topic, and where each recorded conflict's line is now. Which candidates really conflict is the model's
 * call: a word list can find a rule's topic, never its meaning. It only reads.
 */
export async function scanRules(files: Files, probe: PathProbe, at: RulePlaceLocations, conflicts: readonly RuleConflict[]): Promise<RuleScan> {
  const { places, nestedCapped } = await findRulePlaces(files, probe, at);
  const linesByKey = new Map<string, readonly RuleLine[]>();
  for (const place of places) {
    linesByKey.set(pathKey(place.path), await readRuleLines(files, place.path));
  }
  const recorded = await Promise.all(
    conflicts.map(async (conflict): Promise<RecordedConflict> => {
      const path = expandHome(conflict.file, at.userHome);
      const known = linesByKey.get(pathKey(path));
      const lines = known ?? (await readRuleLines(files, path));
      return { conflict, line: recordedLine(conflict, lines)?.line };
    }),
  );
  const quoted = new Set(recorded.flatMap(({ conflict, line }) => (line === undefined ? [] : [`${pathKey(expandHome(conflict.file, at.userHome))}:${line}`])));
  const candidates = places.flatMap((place) =>
    (linesByKey.get(pathKey(place.path)) ?? []).flatMap((line): Candidate[] => {
      const topics = topicsOf(line.text);
      return topics === undefined || quoted.has(`${pathKey(place.path)}:${line.line}`) ? [] : [{ place, line: line.line, text: line.text, topics }];
    }),
  );
  return { places, nestedCapped, recorded, candidates };
}

/** The rule lines of a file (see `ruleLinesOf`); none when it does not exist. */
export async function readRuleLines(files: Files, path: string): Promise<readonly RuleLine[]> {
  const raw = await files.read(path);
  return raw === undefined ? [] : ruleLinesOf(path, raw);
}

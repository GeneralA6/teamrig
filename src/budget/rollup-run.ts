import { join } from 'node:path';
import type { Roster } from '../config/roster.ts';
import type { Files } from '../core/files.ts';
import { sessionsTitled } from '../hooks/bind.ts';
import { attribute } from './attribute.ts';
import { readLines, type TranscriptBytes } from './cursor.ts';
import type { ClaudeSessionFiles, TranscriptSet } from './discover.ts';
import { formatRollup, rollupFileName, type DayRollup } from './rollup-file.ts';
import { parseRollupLine, RollupFold, type RollupSource } from './rollup.ts';

/**
 * One run of the usage rollup: which transcripts are a team's, their fold, and what the run would do to each day's
 * file. Every team of a tree rolls up on its own, so each Claude Code session has to land in exactly one team, or a
 * sum over the tree counts it twice; `attribute` alone asks only "is it this team's?", which the meter can live with.
 */

/** A team of the tree, as attribution reads it. */
export interface TreeMember {
  readonly team: string;
  readonly roster: Roster;
  /** The team session each Claude Code session last read its inbox as. */
  readonly areaBySession: ReadonlyMap<string, string>;
}

export interface TreeAttributionInput {
  /** The team being rolled up. */
  readonly own: string;
  /** Every team of the tree, the own one too, in the one order every team's run reads them in. */
  readonly tree: readonly TreeMember[];
  readonly sessions: readonly ClaudeSessionFiles[];
  /** The title the user gave a Claude Code session, from its transcript; undefined when it has none. */
  titleOf(transcript: string): Promise<string | undefined>;
}

/** The tree team and team session a Claude Code session's inbox mark claims it for. */
interface MarkClaim {
  readonly team: string;
  readonly id: string;
}

/**
 * Who the session's inbox marks claim it for: a team's mark naming a session of that team first. Marks stay in the
 * log of the team that wrote them, so a session moved to another team leaves its old days marked in the team it left;
 * such a mark goes to the one tree team holding the id now, and claims nothing when none or several do.
 */
function markClaimOf(tree: readonly TreeMember[], claudeSession: string): MarkClaim | undefined {
  const marks = tree.flatMap(({ team, roster, areaBySession }) => {
    const id = areaBySession.get(claudeSession);
    return id === undefined ? [] : [{ team, roster, id }];
  });
  const held = marks.find(({ roster, id }) => roster.ids.includes(id));
  if (held !== undefined) {
    return { team: held.team, id: held.id };
  }
  for (const { id } of marks) {
    const [only, ...more] = tree.filter(({ roster }) => roster.ids.includes(id));
    if (only !== undefined && more.length === 0) {
      return { team: only.team, id };
    }
  }
  return undefined;
}

/** How many sessions of the tree a title names. */
function titleClaims(tree: readonly TreeMember[], title: string): number {
  return tree.reduce((claims, { team, roster }) => claims + sessionsTitled({ team, roster }, title).length, 0);
}

/**
 * The team's own sessions' transcripts: `attribute`'s rules over the whole tree. A mark in any team beats a title, and
 * a title counts only when it names one session of the tree, so a title two teams share stays outside both.
 */
export async function attributeInTree(input: TreeAttributionInput): Promise<ReadonlyMap<string, TranscriptSet>> {
  const member = input.tree.find(({ team }) => team === input.own);
  if (member === undefined) {
    return new Map();
  }
  const claims = new Map(input.sessions.map(({ claudeSession }) => [claudeSession, markClaimOf(input.tree, claudeSession)]));
  const areaBySession = new Map<string, string>();
  for (const [claudeSession, claim] of claims) {
    if (claim?.team === input.own) {
      areaBySession.set(claudeSession, claim.id);
    }
  }
  const attribution = await attribute({
    sessions: input.sessions.filter(({ claudeSession }) => [undefined, input.own].includes(claims.get(claudeSession)?.team)),
    team: member.team,
    roster: member.roster,
    areaBySession,
    // The sessions another team of the tree claims are filtered out above, so no peer is left to skip.
    peers: [],
    titleOf: async (transcript) => {
      const title = await input.titleOf(transcript);
      return title !== undefined && titleClaims(input.tree, title) === 1 ? title : undefined;
    },
  });
  return attribution.byTeamSession;
}

export interface TeamFoldInput {
  readonly byTeamSession: ReadonlyMap<string, TranscriptSet>;
  /** The team's lead, whose calls split by call. */
  readonly lead: string | undefined;
  /** The most bytes of a transcript held at once. */
  readonly chunkBytes: number;
}

/** Folds one transcript, a chunk at a time; a last line Claude Code is still writing is left for the next run. */
async function readInto(bytes: TranscriptBytes, path: string, fold: RollupFold, source: RollupSource, chunkBytes: number): Promise<void> {
  const transcript = fold.transcript(source);
  const size = (await bytes.size(path)) ?? 0;
  let offset = 0;
  while (offset < size) {
    const batch = await readLines(bytes, path, offset, size, chunkBytes);
    for (const raw of batch.lines) {
      const line = parseRollupLine(raw);
      if (line !== undefined) {
        transcript.line(line);
      }
    }
    if (batch.end <= offset) {
      break;
    }
    offset = batch.end;
  }
  transcript.end();
}

/** The team's rows per day. Sessions and their transcripts go in sorted, as the first reader of a repeated reply takes it. */
export async function foldTeam(bytes: TranscriptBytes, input: TeamFoldInput): Promise<ReadonlyMap<string, DayRollup>> {
  const fold = new RollupFold();
  for (const [session, { main, subagents }] of [...input.byTeamSession].sort(([a], [b]) => a.localeCompare(b))) {
    const lead = session === input.lead;
    for (const path of [...main].sort()) {
      await readInto(bytes, path, fold, { session, lead, side: false }, input.chunkBytes);
    }
    for (const path of [...subagents].sort()) {
      await readInto(bytes, path, fold, { session, lead, side: true }, input.chunkBytes);
    }
  }
  return fold.rollups();
}

/** The closed UTC days of a run, both ends included. */
export interface RollupRange {
  readonly from: string;
  readonly to: string;
}

/** What a run does to a day's file, rule 11's counts. */
export type DayOutcome = 'inserted' | 'unchanged' | 'changed';

export interface DayPlan {
  readonly day: string;
  readonly path: string;
  readonly text: string;
  readonly outcome: DayOutcome;
  readonly rows: number;
  readonly tasks: number;
  readonly bytes: number;
}

export interface DayPlanInput {
  /** The team's rollup folder. */
  readonly folder: string;
  readonly team: string;
  readonly range: RollupRange;
  readonly rollups: ReadonlyMap<string, DayRollup>;
}

/** Each day of the range with any use, against its file; a day with no use has no plan and no file. */
export async function planDays(files: Pick<Files, 'read'>, input: DayPlanInput): Promise<readonly DayPlan[]> {
  const { folder, team, range, rollups } = input;
  const plans: DayPlan[] = [];
  for (const [day, rollup] of rollups) {
    if (day < range.from || day > range.to) {
      continue;
    }
    const path = join(folder, rollupFileName(day));
    const text = formatRollup({ day, team, rows: rollup.rows, tasks: rollup.tasks });
    const stored = await files.read(path);
    const outcome = stored === undefined ? 'inserted' : stored === text ? 'unchanged' : 'changed';
    plans.push({ day, path, text, outcome, rows: rollup.rows.length, tasks: rollup.tasks.length, bytes: Buffer.byteLength(text) });
  }
  return plans;
}

/** How many days of a plan came out each way. */
export function outcomeCounts(plans: readonly DayPlan[]): Readonly<Record<DayOutcome, number>> {
  const count = (outcome: DayOutcome): number => plans.filter((plan) => plan.outcome === outcome).length;
  return { inserted: count('inserted'), unchanged: count('unchanged'), changed: count('changed') };
}

/**
 * Writes the plan's new days, and its changed ones only with `rewrite`: a day that reads differently can be a day whose
 * transcripts Claude Code has since pruned, and the rows on disk are then the good ones. Returns the days it wrote.
 */
export async function applyPlans(files: Pick<Files, 'write'>, plans: readonly DayPlan[], rewrite: boolean): Promise<readonly string[]> {
  const written: string[] = [];
  for (const plan of plans) {
    if (plan.outcome === 'inserted' || (plan.outcome === 'changed' && rewrite)) {
      await files.write(plan.path, plan.text);
      written.push(plan.day);
    }
  }
  return written;
}

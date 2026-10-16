import type { Roster } from '../config/roster.ts';
import type { Clock } from '../core/lock.ts';
import { attribute } from './attribute.ts';
import { discoverTranscripts, type TranscriptSet, type TranscriptSource } from './discover.ts';
import { runMeter } from './meter.ts';
import type { UsageState, UsageStorage } from './store.ts';

/** The id use outside the team is kept under, in its own store. */
export const OUTSIDE_ID = 'all';
/** The most transcript bytes one meter run reads while catching up. */
export const CATCH_UP_CHUNK_BYTES = 64 * 1024 * 1024;
/** The most meter runs per session in one measure, so a read never runs unbounded. */
export const MAX_RUNS_PER_SESSION = 64;

export interface MeasureDeps {
  readonly transcripts: TranscriptSource;
  /** The title the user gave a Claude Code session, from one of its transcripts. */
  titleOf(transcript: string): Promise<string | undefined>;
  /** Each team session's usage, by its id. */
  readonly team: UsageStorage;
  /** The use of Claude Code sessions outside the team, under `OUTSIDE_ID`. */
  readonly outside: UsageStorage;
  readonly clock: Clock;
}

export interface MeasureInput {
  /** Claude Code's projects folder, where the transcripts are. */
  readonly projectsDir: string;
  /** Transcripts last changed before this are not read. */
  readonly since: number;
  readonly roster: Roster;
  /** The team session each Claude Code session last read its inbox as. */
  readonly areaBySession: ReadonlyMap<string, string>;
  readonly chunkBytes: number;
  readonly maxRuns: number;
}

export interface Measured {
  /** Every team session's usage, metered up to now; an idle one's as stored. */
  readonly bySession: ReadonlyMap<string, UsageState>;
  readonly outside: UsageState;
  readonly outsideSessions: number;
  readonly outsideTitles: readonly string[];
  /** Sessions whose transcripts still had unread lines after the most runs. */
  readonly behind: readonly string[];
}

interface Metered {
  readonly state: UsageState;
  readonly behind: boolean;
}

/** Runs the meter until the session has caught up, at most `maxRuns` times; a run that lost a save race is run again. */
async function meterSession(deps: MeasureDeps, store: UsageStorage, session: string, transcripts: TranscriptSet, input: MeasureInput): Promise<Metered> {
  let state = (await store.load(session)).state;
  for (let run = 0; run < input.maxRuns; run += 1) {
    const result = await runMeter({ bytes: deps.transcripts, store, clock: deps.clock }, { session, transcripts: [...transcripts.main, ...transcripts.subagents], maxBytes: input.chunkBytes });
    if (result.saved) {
      state = result.state;
      if (!result.catchingUp) {
        return { state, behind: false };
      }
    }
  }
  return { state, behind: true };
}

/**
 * Counts every Claude Code session's use up to now into the stores: each team session's transcripts
 * under its id (by its inbox mark, else its title) and everyone else's under `OUTSIDE_ID`.
 */
export async function measure(deps: MeasureDeps, input: MeasureInput): Promise<Measured> {
  const sessions = await discoverTranscripts(deps.transcripts, input.projectsDir, input.since);
  const found = await attribute({ sessions, roster: input.roster, areaBySession: input.areaBySession, titleOf: (path) => deps.titleOf(path) });
  const bySession = new Map<string, UsageState>();
  const behind: string[] = [];
  for (const id of input.roster.ids) {
    const transcripts = found.byTeamSession.get(id);
    if (transcripts === undefined) {
      bySession.set(id, (await deps.team.load(id)).state);
      continue;
    }
    const metered = await meterSession(deps, deps.team, id, transcripts, input);
    bySession.set(id, metered.state);
    if (metered.behind) {
      behind.push(id);
    }
  }
  const outside: Metered =
    found.outsideSessions === 0 ? { state: (await deps.outside.load(OUTSIDE_ID)).state, behind: false } : await meterSession(deps, deps.outside, OUTSIDE_ID, found.outside, input);
  if (outside.behind) {
    behind.push(OUTSIDE_ID);
  }
  return { bySession, outside: outside.state, outsideSessions: found.outsideSessions, outsideTitles: found.outsideTitles, behind };
}

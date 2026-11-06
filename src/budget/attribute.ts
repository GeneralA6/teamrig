import type { Roster } from '../config/roster.ts';
import { sessionsTitled } from '../hooks/bind.ts';
import { customTitleOf, TRANSCRIPT_TAIL_BYTES } from '../names/title.ts';
import type { TranscriptBytes } from './cursor.ts';
import type { ClaudeSessionFiles, TranscriptSet } from './discover.ts';

const NO_TRANSCRIPTS: TranscriptSet = { main: [], subagents: [] };

/** The title the user gave a Claude Code session, from its transcript's last `TRANSCRIPT_TAIL_BYTES`. */
export async function transcriptTitleOf(transcripts: TranscriptBytes, path: string): Promise<string | undefined> {
  const size = (await transcripts.size(path)) ?? 0;
  const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
  return length === 0 ? undefined : customTitleOf((await transcripts.read(path, size - length, length)).toString('utf8'));
}

/** The team session a Claude Code session works as, and why. */
export interface Attribution {
  /** Each team session's transcripts: its own Claude Code sessions' and their subagents'. */
  readonly byTeamSession: ReadonlyMap<string, TranscriptSet>;
  /** The transcripts of Claude Code sessions that are no team session (another project, an unnamed tab). */
  readonly outside: TranscriptSet;
  /** How many Claude Code sessions are outside the team, and the titles of those that have one. */
  readonly outsideSessions: number;
  readonly outsideTitles: readonly string[];
}

export interface AttributionInput {
  readonly sessions: readonly ClaudeSessionFiles[];
  readonly team: string;
  readonly roster: Roster;
  /** The team session each Claude Code session last read its inbox as (the inbox marks). */
  readonly areaBySession: ReadonlyMap<string, string>;
  /** The title the user gave a Claude Code session, from its transcript; undefined when it has none. */
  titleOf(transcript: string): Promise<string | undefined>;
}

/**
 * Which team session each Claude Code session's use counts for, by the same rules that bind a tab:
 * its inbox mark first, else its title when that is exactly one team session's id or current name.
 * A session that only ran subagents has no title of its own and goes by its mark alone.
 */
export async function attribute(input: AttributionInput): Promise<Attribution> {
  const byTeamSession = new Map<string, TranscriptSet>();
  let outside = NO_TRANSCRIPTS;
  const outsideTitles: string[] = [];
  let outsideSessions = 0;
  for (const session of input.sessions) {
    const marked = input.areaBySession.get(session.claudeSession);
    let id = marked !== undefined && input.roster.ids.includes(marked) ? marked : undefined;
    let title: string | undefined;
    if (id === undefined) {
      title = await titleOfFirst(input, session.main);
      const titled = title === undefined ? [] : sessionsTitled({ team: input.team, roster: input.roster }, title);
      id = titled.length === 1 ? titled[0] : undefined;
    }
    if (id === undefined) {
      outside = joined(outside, session);
      outsideSessions += 1;
      if (title !== undefined && !outsideTitles.includes(title)) {
        outsideTitles.push(title);
      }
      continue;
    }
    byTeamSession.set(id, joined(byTeamSession.get(id) ?? NO_TRANSCRIPTS, session));
  }
  return { byTeamSession, outside, outsideSessions, outsideTitles };
}

/** Both sets' transcripts, each kind in order. */
function joined(set: TranscriptSet, more: TranscriptSet): TranscriptSet {
  return { main: [...set.main, ...more.main], subagents: [...set.subagents, ...more.subagents] };
}

async function titleOfFirst(input: AttributionInput, transcripts: readonly string[]): Promise<string | undefined> {
  for (const transcript of transcripts) {
    const title = await input.titleOf(transcript);
    if (title !== undefined) {
      return title;
    }
  }
  return undefined;
}

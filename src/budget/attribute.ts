import type { Roster } from '../config/roster.ts';
import { sessionsTitled } from '../hooks/bind.ts';
import type { ClaudeSessionFiles } from './discover.ts';

/** The team session a Claude Code session works as, and why. */
export interface Attribution {
  /** Each team session's transcripts, its own Claude Code sessions' and their subagents'. */
  readonly byTeamSession: ReadonlyMap<string, readonly string[]>;
  /** The transcripts of Claude Code sessions that are no team session (another project, an unnamed tab). */
  readonly outside: readonly string[];
  /** How many Claude Code sessions are outside the team, and the titles of those that have one. */
  readonly outsideSessions: number;
  readonly outsideTitles: readonly string[];
}

export interface AttributionInput {
  readonly sessions: readonly ClaudeSessionFiles[];
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
  const byTeamSession = new Map<string, string[]>();
  const outside: string[] = [];
  const outsideTitles: string[] = [];
  let outsideSessions = 0;
  for (const session of input.sessions) {
    const files = [...session.main, ...session.subagents];
    const marked = input.areaBySession.get(session.claudeSession);
    let id = marked !== undefined && input.roster.ids.includes(marked) ? marked : undefined;
    let title: string | undefined;
    if (id === undefined) {
      title = await titleOfFirst(input, session.main);
      const titled = title === undefined ? [] : sessionsTitled(input.roster, title);
      id = titled.length === 1 ? titled[0] : undefined;
    }
    if (id === undefined) {
      outside.push(...files);
      outsideSessions += 1;
      if (title !== undefined && !outsideTitles.includes(title)) {
        outsideTitles.push(title);
      }
      continue;
    }
    byTeamSession.set(id, [...(byTeamSession.get(id) ?? []), ...files]);
  }
  return { byTeamSession, outside, outsideSessions, outsideTitles };
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

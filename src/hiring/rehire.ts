import type { HiringConfig } from '../config/types.ts';

/**
 * Whether a rehired session resumes its last Claude Code session (`teamrig open --resume`) or starts fresh on
 * its handover: it resumes only when that session's transcript is still in the project folder, its context is
 * at most `hiring.resumeMaxTokens` and it was idle at most `hiring.resumeMaxIdleDays`. Pure: the caller
 * measures the facts.
 */

/** What was measured of the session's last Claude Code session. */
export interface ResumeFacts {
  /** The Claude Code session that last read the session's inbox; undefined when none is on record. */
  readonly claudeSession: string | undefined;
  /** When its transcript in the project folder last changed (epoch ms); undefined when it is gone. */
  readonly changedAt: number | undefined;
  /** The context tokens at its last turn; undefined when they could not be read. */
  readonly tokens: number | undefined;
}

export type ResumeVerdict =
  | { readonly kind: 'resume'; readonly claudeSession: string; readonly detail: string }
  | { readonly kind: 'fresh'; readonly detail: string };

const DAY_MS = 86_400_000;

/** The verdict with its reason in words, the numbers included, at the clock's `now` (epoch ms). */
export function resumeVerdict(facts: ResumeFacts, hiring: Pick<HiringConfig, 'resumeMaxTokens' | 'resumeMaxIdleDays'>, now: number): ResumeVerdict {
  const { claudeSession, changedAt, tokens } = facts;
  if (claudeSession === undefined) {
    return { kind: 'fresh', detail: 'no Claude Code session of it is on record' };
  }
  const last = `its last Claude Code session ${claudeSession}`;
  if (changedAt === undefined) {
    return { kind: 'fresh', detail: `${last} has no transcript in this project folder` };
  }
  if (tokens === undefined) {
    return { kind: 'fresh', detail: `the context of ${last} could not be read` };
  }
  const idle = Math.max(0, now - changedAt);
  const days = (idle / DAY_MS).toFixed(1);
  const size = `${tokens} tokens of context, idle ${days} day(s)`;
  if (tokens > hiring.resumeMaxTokens) {
    return { kind: 'fresh', detail: `${last} holds ${size}: over hiring.resumeMaxTokens ${hiring.resumeMaxTokens}` };
  }
  if (idle > hiring.resumeMaxIdleDays * DAY_MS) {
    return { kind: 'fresh', detail: `${last} holds ${size}: over hiring.resumeMaxIdleDays ${hiring.resumeMaxIdleDays}` };
  }
  return { kind: 'resume', claudeSession, detail: `${last} holds ${size}` };
}

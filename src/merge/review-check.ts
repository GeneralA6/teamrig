import type { Env } from '../core/home.ts';
import { REVIEW_CHECK_FLAGGED, type CheckOutcome } from '../push-guard/review-gate.ts';
import { hookEndText, hookExitCode, type HookRunner } from '../deploy/hooks.ts';

/** Names, for the review check, the commit the change is reviewed against: it reviews `$TEAMRIG_REVIEW_BASE..HEAD`. */
export const REVIEW_BASE_ENV = 'TEAMRIG_REVIEW_BASE';

/** How much of what a flagging check printed the hold keeps: its first lines, each cut to a length. */
export const REVIEW_FINDINGS_LIMITS = {
  maxLines: 200,
  maxLineLength: 500,
} as const;

/** A review check to run on a change: `delivery.repos.<name>.reviewCheck` in the checkout at the change. */
export interface ReviewCheck {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The commit the change is reviewed against: the default branch's tip it was rebased onto. */
  readonly base: string;
  readonly env: Env;
  readonly timeoutMs: number;
  /** A line as it may be shown and kept, its secrets masked (`shownLine`). */
  readonly redact: (line: string) => string;
  /** Hears each line the check prints, redacted, as it comes. */
  readonly onLine: (line: string) => void;
}

/**
 * Runs the check and reads how it ended (T800 §2.2): exit 0 clean, exit {@link REVIEW_CHECK_FLAGGED} flagged with what
 * it printed as the findings (redacted, bounded by {@link REVIEW_FINDINGS_LIMITS}), anything else broken, which the
 * gate holds for a leader as no pass.
 */
export async function runReviewCheck(hooks: HookRunner, check: ReviewCheck): Promise<CheckOutcome> {
  const { argv, cwd, base, env, timeoutMs, redact, onLine } = check;
  const kept: string[] = [];
  let printed = 0;
  const end = await hooks.run({
    argv,
    cwd,
    env: { ...env, [REVIEW_BASE_ENV]: base },
    timeoutMs,
    onLine: (line) => {
      const shown = redact(line);
      onLine(shown);
      printed += 1;
      if (kept.length < REVIEW_FINDINGS_LIMITS.maxLines) {
        kept.push(shown.slice(0, REVIEW_FINDINGS_LIMITS.maxLineLength));
      }
    },
  });
  if (end.kind === 'exited' && end.code === 0) {
    return { kind: 'clean' };
  }
  if (end.kind === 'exited' && end.code === REVIEW_CHECK_FLAGGED) {
    const left = printed - kept.length;
    return { kind: 'flagged', findings: [...kept, ...(left > 0 ? [`… ${left} more line(s) in the merge output`] : [])].join('\n') };
  }
  return { kind: 'broken', detail: hookEndText(end), exitCode: hookExitCode(end) };
}

/** The exit code the ledger records for the check: 0 clean, {@link REVIEW_CHECK_FLAGGED} flagged, else how it broke. */
export function checkExitCode(outcome: CheckOutcome): number {
  switch (outcome.kind) {
    case 'clean':
      return 0;
    case 'flagged':
      return REVIEW_CHECK_FLAGGED;
    case 'broken':
      return outcome.exitCode;
  }
}

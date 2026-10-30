import type { BurstConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import { formatPct } from './format.ts';
import { spareShareNote, surplusOf, type Burst } from './burst.ts';
import type { Lift } from './lift.ts';
import type { WeekWindow } from './pace.ts';
import type { TeamsOnAccount } from './parts.ts';

/**
 * The burst's part of the live budget lines, pure: the person's line when a burst the session is in
 * starts and when it ends; the model's line once at its start (how to work in it) and once at its end
 * (wind down); and the lead's model line once a week when a surplus is worth a burst. A line only
 * suggests: only a person starts a burst, by `teamrig burst start`.
 */

export const BURST_COMMAND = `${KIT_NAME} burst`;

export const MORE_BURST = `More: ${BURST_COMMAND}`;

/** A surplus worth a burst, as the lead's hook reads it. */
export interface SurplusHint {
  /** The team's part of the share of the week projected unused at the pace end, in % (`Surplus.sparePct`). */
  readonly sparePct: number;
  /** All of it on the account, when other teams share it (`Surplus.accountSparePct`). */
  readonly accountSparePct: number | undefined;
  readonly paceEnd: number;
  /** The reset that names the week, so the line shows once a week. */
  readonly reset: number;
  /** Whom the lead asks first under `burst.policy` owner; undefined when the lead decides. */
  readonly ownerAsk: string | undefined;
}

export interface SurplusHintInput {
  readonly config: BurstConfig;
  readonly window: WeekWindow | undefined;
  readonly now: number;
  readonly usedPct: number;
  readonly targetPct: number;
  /** The team and the other teams on its account, which split the spare (`surplusOf`). */
  readonly teams: TeamsOnAccount;
  /** Whom the lead asks to approve a burst under `burst.policy` owner: the owner, or a child team's parent lead. */
  readonly ownerAsk: string;
}

/** The surplus worth a burst now, for the lead's line; undefined with `burst.policy` off, an unknown week or too little spare. */
export function surplusHintOf(input: SurplusHintInput): SurplusHint | undefined {
  const { config, window } = input;
  if (config.policy === 'off' || window === undefined) {
    return undefined;
  }
  const surplus = surplusOf({ window, now: input.now, usedPct: input.usedPct, targetPct: input.targetPct, config, teams: input.teams });
  return surplus === undefined || !surplus.worth
    ? undefined
    : {
        sparePct: surplus.sparePct,
        accountSparePct: surplus.accountSparePct,
        paceEnd: surplus.paceEnd,
        reset: surplus.reset,
        ownerAsk: config.policy === 'owner' ? input.ownerAsk : undefined,
      };
}

/** What the burst lines read of a session's budget now. */
export interface BurstFacts {
  readonly name: string;
  /** Its daily budget now, in % of the week. */
  readonly budgetPct: number;
  /** The burst in force, when the session is in it. */
  readonly burst: Burst | undefined;
  /** For the lead only, with no burst in force: a surplus worth one. */
  readonly surplus: SurplusHint | undefined;
  /** The team's zone, which the lines print their times in. */
  readonly zone: TimeZone;
}

/** What the burst lines already showed a session, so each shows once. */
export interface BurstMarks {
  /** The `at` of the burst whose start the person was shown; undefined once its end was shown. */
  readonly burstAt: number | undefined;
  /** The `at` of the burst whose start the model was told; undefined once its end was told. */
  readonly modelBurstAt: number | undefined;
  /** The reset of the week whose surplus the lead's model was told. */
  readonly surplusShown: number | undefined;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** When it ends, as a clause on the team's clock: "until Wed 01-09 02:00 IST or 99.5% of the week". */
function endText(burst: Burst, zone: TimeZone): string {
  return `until ${zone.weekdayMinute(new Date(burst.endsAt))} or ${formatPct(burst.stopPct)} of the week`;
}

/** Its tasks, as a clause; '' for a surplus burst. */
function tasksText(burst: Burst, zone: TimeZone): string {
  if (burst.tasks.length === 0) {
    return '';
  }
  return ` for ${burst.tasks.join(', ')}${burst.deadline === undefined ? '' : ` (due ${zone.weekdayMinute(new Date(burst.deadline))})`}`;
}

/**
 * A burst as the person reads it, for the sessions named: "a surplus burst until ...: alpha's daily
 * budget is at least ...", or "alpha, bravo each have a daily budget of at least ..." for several, with
 * `floorPct`: the floor now (`burstFloorOf`), or its start reading (`dailyPct`) in a line about its start.
 */
export function burstText(burst: Burst, names: readonly string[], zone: TimeZone, floorPct: number): string {
  const hires = burst.hires === 0 ? '' : `, ${plural(burst.hires, 'hire')} for the team`;
  const whose = names.length === 1 ? `${names.join('')}'s daily budget is at least` : `${names.join(', ')} each have a daily budget of at least`;
  return `a ${burst.kind} burst${tasksText(burst, zone)} ${endText(burst, zone)}: ${whose} ${formatPct(floorPct)}, up to ${plural(burst.helpers, 'helper')} at once${hires}.`;
}

/**
 * Why a session's daily budget is not the shared one: " (lifted)" (a lift sets its part), " (burst)" (a burst's floor
 * holds it up, a paused one too), " (paused)" (a short day funds none of its work), or ''.
 */
export function budgetMarkOf(lift: Lift | undefined, inBurst: boolean, paused: boolean): string {
  if (lift !== undefined) {
    return ' (lifted)';
  }
  if (inBurst) {
    return ' (burst)';
  }
  return paused ? ' (paused)' : '';
}

/** The person's line at a turn's end when the session's burst starts or ends, and the mark to keep. */
export function burstStopLines(facts: BurstFacts, marks: BurstMarks): { readonly lines: readonly string[]; readonly burstAt: number | undefined } {
  const { burst } = facts;
  if (burst !== undefined) {
    return burst.at === marks.burstAt ? { lines: [], burstAt: burst.at } : { lines: [`Budget: the lead started ${burstText(burst, [facts.name], facts.zone, facts.budgetPct)} ${MORE_BURST}`], burstAt: burst.at };
  }
  if (marks.burstAt !== undefined) {
    return { lines: [`Budget: ${facts.name}'s burst has ended; its daily budget is ${formatPct(facts.budgetPct)} again.`], burstAt: undefined };
  }
  return { lines: [], burstAt: undefined };
}

/** How the model works in a burst: the caps, the split, the gates it keeps. */
function burstModelLine(burst: Burst, zone: TimeZone): string {
  const first = burst.tasks.length === 0 ? '' : ` Work its tasks first: ${burst.tasks.join(', ')}.`;
  const hires = burst.hires === 0 ? '' : ` The lead may hire up to ${plural(burst.hires, 'session')} for it (${KIT_NAME} hire --burst).`;
  return (
    `${BURST_COMMAND}: a ${burst.kind} burst runs ${endText(burst, zone)}.${first} ` +
    `Run up to ${plural(burst.helpers, 'helper')} at once, on independent tasks only; give each edit in a repo its own worktree, and merge one change at a time. ` +
    `Helpers run on your model and effort, never a cheaper model or lower effort, and never skip a test or check.${hires} ${MORE_BURST}`
  );
}

const BURST_END_LINE =
  `${BURST_COMMAND}: the burst has ended. Finish the step in hand and start no new helpers; ` +
  `the burst's hires are due to retire (${KIT_NAME} check lists them). ${MORE_BURST}`;

function surplusLine(surplus: SurplusHint, zone: TimeZone): string {
  const approval = surplus.ownerAsk === undefined ? '' : ` burst.policy is owner, so first ask ${surplus.ownerAsk}, then add --approved-by "<who>".`;
  return (
    `${BURST_COMMAND}: about ${formatPct(surplus.sparePct)} of the week${spareShareNote(surplus)} is projected unused at the pace end (${zone.weekdayMinute(new Date(surplus.paceEnd))}). ` +
    `A surplus burst can spend it on independent tasks; preview one: ${BURST_COMMAND} start surplus --reason "<why>".${approval} ${MORE_BURST}`
  );
}

export interface BurstPrompt {
  readonly lines: readonly string[];
  readonly modelBurstAt: number | undefined;
  readonly surplusShown: number | undefined;
}

/** The model's burst lines with a prompt: its start or end once, and a surplus once a week; and the marks to keep. */
export function burstPromptLines(facts: BurstFacts, marks: BurstMarks): BurstPrompt {
  const lines: string[] = [];
  const { burst, surplus } = facts;
  if (burst !== undefined && burst.at !== marks.modelBurstAt) {
    lines.push(burstModelLine(burst, facts.zone));
  } else if (burst === undefined && marks.modelBurstAt !== undefined) {
    lines.push(BURST_END_LINE);
  }
  const showSurplus = burst === undefined && surplus !== undefined && surplus.reset !== marks.surplusShown;
  if (showSurplus) {
    lines.push(surplusLine(surplus, facts.zone));
  }
  return { lines, modelBurstAt: burst?.at, surplusShown: showSurplus ? surplus.reset : marks.surplusShown };
}

import type { Goal, GoalSlip } from '../register/goals.ts';
import { ServedText, type Cut, type SecretShapes } from './text.ts';

/** One move of a goal's target day, with who moved it and why. */
export interface ServedSlip {
  /** When it was moved, ISO in UTC. */
  readonly at: string;
  readonly by: string;
  /** The target day before and after, `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
  readonly note: string;
}

/**
 * A goal a task of the team may serve. Its texts are the team's own, written by its lead, so they are served plain;
 * they are still scanned, as every text a person typed is.
 */
export interface ServedGoal {
  readonly tag: string;
  /** The team whose goals file holds it: the asked team or one above it. */
  readonly team: string;
  readonly title: string;
  /** The tag of the goal it is a part of; null for a goal that is part of none. */
  readonly parent: string | null;
  /** Its place in its team's ranking, 1 first; null for a goal the lead has not ranked. */
  readonly rank: number | null;
  /** The number of the slice now open, 1 first; null while none is. */
  readonly slice: number | null;
  /** The first and the target day of its window, `YYYY-MM-DD`. */
  readonly start: string;
  readonly target: string;
  /** Every move of its target day, the oldest first. */
  readonly slips: readonly ServedSlip[];
}

/** The `goals` document's own fields. */
export interface GoalsBody {
  /** The ranked goals first, by rank and then by tag, then the others by tag. */
  readonly goals: readonly ServedGoal[];
  readonly cuts: readonly Cut[];
}

/** The goals one team's file holds. */
export interface HeldGoals {
  readonly team: string;
  readonly goals: Iterable<Goal>;
}

export interface GoalsInput {
  /** The goals of each team a task may serve one of: the root's first, the asked team's last. */
  readonly held: readonly HeldGoals[];
  readonly shapes: SecretShapes;
}

/**
 * The `goals` document's body. A tag two teams hold is served once, as the nearer team's goal: that is the goal a
 * task of the asked team serves by that tag, so a reader that ranks by it reads the goal teamrig ranks by. It makes
 * its own `ServedText`, so `cuts` lists this document's cuts and no other's; a cut names its goal by tag.
 */
export function goalsBody(input: GoalsInput): GoalsBody {
  const nearest = new Map<string, { readonly team: string; readonly goal: Goal }>();
  for (const { team, goals } of input.held) {
    for (const goal of goals) {
      nearest.set(goal.tag, { team, goal });
    }
  }
  const served = new ServedText(input.shapes);
  const goals = [...nearest.values()].sort((one, other) => inOrder(one.goal, other.goal)).map(({ team, goal }) => servedGoal(team, goal, served));
  return { goals, cuts: served.cuts };
}

function inOrder(one: Goal, other: Goal): number {
  if (one.rank !== other.rank) {
    if (one.rank === null) {
      return 1;
    }
    return other.rank === null ? -1 : one.rank - other.rank;
  }
  return one.tag < other.tag ? -1 : one.tag > other.tag ? 1 : 0;
}

function servedGoal(team: string, goal: Goal, served: ServedText): ServedGoal {
  return {
    tag: goal.tag,
    team,
    title: served.plain(goal.tag, 'title', goal.title),
    parent: goal.parent,
    rank: goal.rank,
    slice: goal.slice,
    start: goal.start,
    target: goal.target,
    slips: goal.slips.map((slip, index) => servedSlip(goal.tag, index, slip, served)),
  };
}

/**
 * A slip written out field by field. `at` is served as the instant it reads as, never as the text stored: a goal
 * record's parse holds it to teamrig's stamp, and this keeps a goal built any other way from carrying words in it.
 */
function servedSlip(tag: string, index: number, slip: GoalSlip, served: ServedText): ServedSlip {
  return { at: new Date(slip.at).toISOString(), by: slip.by, from: slip.from, to: slip.to, note: served.plain(tag, `slips.${index}.note`, slip.note) };
}

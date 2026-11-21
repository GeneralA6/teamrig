import { ServedText } from "./text.js";
/**
 * The `goals` document's body. A tag two teams hold is served once, as the nearer team's goal: that is the goal a
 * task of the asked team serves by that tag, so a reader that ranks by it reads the goal teamrig ranks by. It makes
 * its own `ServedText`, so `cuts` lists this document's cuts and no other's; a cut names its goal by tag.
 */
export function goalsBody(input) {
    const nearest = new Map();
    for (const { team, goals } of input.held) {
        for (const goal of goals) {
            nearest.set(goal.tag, { team, goal });
        }
    }
    const served = new ServedText(input.shapes);
    const goals = [...nearest.values()].sort((one, other) => inOrder(one.goal, other.goal)).map(({ team, goal }) => servedGoal(team, goal, served));
    return { goals, cuts: served.cuts };
}
function inOrder(one, other) {
    if (one.rank !== other.rank) {
        if (one.rank === null) {
            return 1;
        }
        return other.rank === null ? -1 : one.rank - other.rank;
    }
    return one.tag < other.tag ? -1 : one.tag > other.tag ? 1 : 0;
}
function servedGoal(team, goal, served) {
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
export function servedSlip(tag, index, slip, served) {
    return { at: new Date(slip.at).toISOString(), by: slip.by, from: slip.from, to: slip.to, note: served.plain(tag, `slips.${index}.note`, slip.note) };
}

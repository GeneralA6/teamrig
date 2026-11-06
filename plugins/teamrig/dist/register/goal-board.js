import { goalChain } from "./focus.js";
import { ACTIVE_STATUSES } from "./model.js";
import { wholeSizePctOf } from "./score.js";
import { taskLabel } from "./views.js";
function isRanked(goal) {
    return goal.rank !== null;
}
/** True for an active task past its effective due: its own, or an earlier one of a task that needs it. */
export function isLate(task, tree, now) {
    return ACTIVE_STATUSES.includes(task.status) && (tree.dueTime(task) ?? Number.POSITIVE_INFINITY) < now;
}
/** A team's tasks that serve a goal: any of their tags, or a goal up that tag's chain. A dropped task serves nothing. */
function servingTasks(team, tag) {
    return team.tasks.filter((task) => task.status !== 'dropped' && task.goals.some((own) => goalChain(own, team.goals).some(([at]) => at === tag)));
}
function total(values) {
    return values.reduce((sum, value) => sum + value, 0);
}
function goalScore(goal, teams, now) {
    const serving = teams.map((team) => ({ team, tasks: servingTasks(team, goal.tag) }));
    const tasks = serving.flatMap((read) => read.tasks);
    const sized = serving.flatMap(({ team, tasks: own }) => own
        .filter((task) => team.tree.task(task.id) !== undefined)
        .map((task) => {
        const facts = team.ranking.sizingOf(task);
        return { spentPct: facts.spentPct, sizePct: wholeSizePctOf(facts, team.ranking.focus.score) };
    }));
    return {
        tag: goal.tag,
        title: goal.title,
        rank: goal.rank,
        target: goal.target,
        done: tasks.filter((task) => task.status === 'done').length,
        total: tasks.length,
        spentPct: total(sized.map((facts) => facts.spentPct)),
        sizePct: total(sized.map((facts) => facts.sizePct)),
        slips: goal.slips.length,
        overdue: serving.flatMap(({ team, tasks: own }) => own.filter((task) => isLate(task, team.tree, now))).length,
        waiting: serving.flatMap(({ team, tasks: own }) => team.tree.inPlanOrder(own.filter((task) => task.status === 'waiting')).map((task) => taskLabel(task, team.team))),
    };
}
/**
 * The rows of a meeting's ranked goals, best rank first, a tie in the order added. `goals` are the root team's, as the
 * meeting is the root lead's; a tag a team under it also holds reads as one row, by tag.
 */
export function goalScores(goals, teams, now) {
    return [...goals.values()]
        .filter(isRanked)
        .sort((a, b) => a.rank - b.rank)
        .map((goal) => goalScore(goal, teams, now));
}

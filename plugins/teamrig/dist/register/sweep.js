import { isRecord } from "../core/guards.js";
import { MS_PER_DAY } from "../core/time.js";
import { ACTIVE_STATUSES } from "./model.js";
/**
 * The goal-first sweep (T2076 part 1D): what class, objective and size each active task should take, proposed from what
 * the register already holds, and which of those proposals a person confirmed. Nothing here writes: the command reads
 * the tasks and goals, a person edits the rows, and only a row marked `yes` becomes a register update. Pure, so the
 * rules and the apply diff are held by tests without a register.
 */
export const SWEEP_CONFIDENCES = ['high', 'medium', 'low'];
/** The `confirm` of a row a person accepted; any other value leaves the row. */
export const SWEEP_CONFIRMED = 'yes';
/** The title words that mark upkeep rather than planned work; `data loss` matches as two words in a row. */
const MAINTENANCE_WORDS = ['incident', 'outage', 'security', 'exposure', 'leak', 'data loss', 'backup', 'restore'];
const MAINTENANCE_TITLE = new RegExp(`\\b(${MAINTENANCE_WORDS.join('|')})s?\\b`, 'i');
/** Words too common in task and goal titles to say the two are about the same thing. */
const STOP_WORDS = new Set(['about', 'after', 'each', 'every', 'from', 'goal', 'have', 'into', 'more', 'over', 'task', 'tasks', 'that', 'their', 'them', 'then', 'this', 'when', 'with']);
/** The shortest word that counts toward a title match. */
const MIN_TITLE_WORD = 4;
/** How many words a title shares with a goal's for a match: one shared word is usually chance. */
const MIN_SHARED_WORDS = 2;
/** The words of a title that can match, lower case, each once. */
export function titleWords(title) {
    const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    return new Set(words.filter((word) => word.length >= MIN_TITLE_WORD && !STOP_WORDS.has(word)));
}
/** The goal up a chain from `tag`, itself first. A chain is walked once, so a damaged file's loop cannot hang it. */
function chainOf(tag, goals) {
    const chain = [];
    const walked = new Set();
    for (let at = tag; at !== null && !walked.has(at);) {
        walked.add(at);
        const goal = goals.get(at);
        if (goal === undefined) {
            break;
        }
        chain.push(goal);
        at = goal.parent;
    }
    return chain;
}
/** True for a `tag` that sits under `record` by its name: `K1a` and `K1.2` under `K1`, never `K10`, a goal of its own. */
function isSubTag(tag, record) {
    if (tag === record || !tag.startsWith(record)) {
        return false;
    }
    const next = tag.charAt(record.length);
    return next === '.' || next === '-' || (/\d$/.test(record) && /[A-Za-z]/.test(next));
}
/**
 * The task's tags with no record, each with the longest record it sits under, so a rank on that record reaches the
 * task: the key-result cap leaves no room to give each such tag a record of its own. A tag with no record above it stays
 * out, and so does one whose record the task names already, which leaves a rerun after apply with nothing more to add.
 */
function looseTagsOf(task, goals) {
    const longestFirst = [...goals.values()].sort((a, b) => b.tag.length - a.tag.length);
    return task.goals.flatMap((tag) => {
        const record = goals.has(tag) ? undefined : longestFirst.find((goal) => isSubTag(tag, goal.tag));
        return record === undefined || task.goals.includes(record.tag) ? [] : [{ tag, record }];
    });
}
/** The ranked goals among `goals`, the best (lowest) rank first; a tie keeps the order given. */
function rankedFirst(goals) {
    return goals.filter((goal) => goal.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
}
/** The best ranked goal among `tags` and their ancestors, as `rankOf` reads it, for the tag it names. */
function bestGoalOf(tags, goals) {
    return rankedFirst(tags.flatMap((tag) => chainOf(tag, goals))).at(0);
}
/** The ranked goal a title shares the most words with, the better rank first; undefined when none reaches the bar. */
function titleMatchOf(title, goals) {
    const words = titleWords(title);
    let best;
    for (const goal of rankedFirst([...goals.values()])) {
        const shared = [...titleWords(goal.title)].filter((word) => words.has(word));
        if (shared.length >= MIN_SHARED_WORDS && shared.length > (best?.shared.length ?? 0)) {
            best = { goal, shared };
        }
    }
    return best;
}
/** Why a task reads as upkeep; undefined when it does not. */
function maintenanceReason(task) {
    if (task.critical) {
        return 'marked critical';
    }
    if (task.type === 'bug') {
        return 'a bug';
    }
    const word = MAINTENANCE_TITLE.exec(task.title)?.[1];
    return word === undefined ? undefined : `title says ${word.toLowerCase()}`;
}
/** The class, objective, reason and confidence the rules give a task, the first rule that holds deciding. */
export function proposalOf(task, input) {
    const { focus, goals } = input;
    const loose = looseTagsOf(task, goals);
    const best = bestGoalOf([...task.goals, ...loose.map(({ record }) => record.tag)], goals);
    // The row names the nearest record, not the ranked goal above it, so a rank given to that record later counts too.
    const added = best === undefined ? loose.at(0) : loose.find(({ record }) => chainOf(record.tag, goals).includes(best));
    const nearest = added?.record.tag ?? null;
    const note = added === undefined ? '' : `; tag ${added.tag} has no record, nearest is ${added.record.tag}`;
    if (task.workClass !== null) {
        // A class already stored was a person's call, or a row they confirmed: a later sweep never argues with it.
        return { class: task.workClass, objective: nearest ?? best?.tag ?? null, reason: `class already set${note}`, confidence: 'high' };
    }
    if (best !== undefined) {
        // Through a nearest record the class rests on a tag's name alone, which is less than a person naming the goal.
        return { class: focus.roadmapClass, objective: nearest ?? best.tag, reason: `serves ranked goal ${best.tag} (#${String(best.rank)})${note}`, confidence: added === undefined ? 'high' : 'medium' };
    }
    const upkeep = maintenanceReason(task);
    if (upkeep !== undefined) {
        return { class: focus.maintenanceClass, objective: nearest, reason: `${upkeep}${note}`, confidence: task.critical ? 'high' : 'medium' };
    }
    const match = titleMatchOf(task.title, goals);
    if (match !== undefined) {
        return { class: focus.roadmapClass, objective: match.goal.tag, reason: `title shares ${match.shared.join(', ')} with goal ${match.goal.tag}`, confidence: 'low' };
    }
    return { class: focus.defaultClass, objective: nearest, reason: `no ranked goal, no upkeep sign${note}`, confidence: 'medium' };
}
/**
 * Whether phase 2 would park the task, the rule of design section 6 (2C): only a STORED class counts, so a task no one
 * classed never parks, and nothing parks until confirmed rows land. A waiting or verifying task stays out, as parking
 * one would lose its READY and its proof date.
 */
export function wouldPark(task, input) {
    const { focus } = input;
    const stored = task.workClass;
    if (stored === null || stored === focus.roadmapClass || stored === focus.maintenanceClass) {
        return false;
    }
    const quietFor = input.now - Date.parse(task.updatedAt);
    return (task.status === 'open' &&
        quietFor >= focus.parkAfterDays * MS_PER_DAY &&
        task.pin === null &&
        !task.critical &&
        task.source !== input.ownerSource &&
        !input.needed(task.id));
}
/** The proposal for one active task, its `confirm` left empty for a person. */
export function proposeRow(task, input) {
    const proposal = proposalOf(task, input);
    const size = Number(input.sizeOf(task).toFixed(2));
    return {
        id: task.id,
        team: input.team,
        owner: task.owner,
        title: task.title,
        class: proposal.class,
        objective: proposal.objective,
        size,
        proposedSize: size,
        reason: proposal.reason,
        confidence: proposal.confidence,
        park: wouldPark(task, input),
        confirm: '',
    };
}
/** How many rows each team holds of each class, teams and classes by name. */
export function sweepCounts(rows) {
    const teams = new Map();
    for (const row of [...rows].sort((a, b) => a.team.localeCompare(b.team) || a.class.localeCompare(b.class))) {
        const classes = teams.get(row.team) ?? new Map();
        classes.set(row.class, (classes.get(row.class) ?? 0) + 1);
        teams.set(row.team, classes);
    }
    return teams;
}
/** One line per team of {@link sweepCounts}: `alpha: Improvements 3, Roadmap 1`. */
export function countLines(rows) {
    return [...sweepCounts(rows)].map(([team, classes]) => `${team}: ${[...classes].map(([name, count]) => `${name} ${String(count)}`).join(', ')}`);
}
const TASK_ID = /^T\d+$/;
function isText(value) {
    return typeof value === 'string' && value.trim() !== '';
}
function isConfidence(value) {
    return SWEEP_CONFIDENCES.some((confidence) => confidence === value);
}
/** A share of the week above 0, at most 100, as `--size` takes it. */
function isSizePct(value) {
    return typeof value === 'number' && value > 0 && value <= 100;
}
/** A size a person may leave: none, or a share of the week. */
function isRowSize(value) {
    return value === null || isSizePct(value);
}
/** Every field of a row but `proposedSize`, so a parse can name what a file from an older sweep lacks. */
function isRowBody(value) {
    return (isRecord(value) &&
        typeof value['id'] === 'string' &&
        TASK_ID.test(value['id']) &&
        isText(value['team']) &&
        isText(value['owner']) &&
        typeof value['title'] === 'string' &&
        isText(value['class']) &&
        (value['objective'] === null || isText(value['objective'])) &&
        isRowSize(value['size']) &&
        typeof value['reason'] === 'string' &&
        isConfidence(value['confidence']) &&
        typeof value['park'] === 'boolean' &&
        typeof value['confirm'] === 'string');
}
export function isSweepRow(value) {
    return isRowBody(value) && 'proposedSize' in value && isSizePct(value.proposedSize);
}
/** The shape of a sweep file's line, named in a refusal. */
export const SWEEP_ROW_SHAPE = '{"id": "T<n>", "team": "<team>", "owner": "<session>", "class": "<class>", "objective": "<tag>"|null, "size": <pct>|null, "proposedSize": <pct>, "reason": "..", "confidence": "high|medium|low", "park": false, "confirm": ""}';
/** The JSONL text of the rows, one line each. */
export function formatSweepRows(rows) {
    return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}
/**
 * The rows of a sweep file. Refused whole on a line that is no row or a task named twice: a person edited this file, so
 * a damaged line may be the one they meant to confirm, and writing the rest would leave them guessing what landed.
 */
export function parseSweepFile(text) {
    const rows = [];
    const seen = new Set();
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line.trim() === '') {
            continue;
        }
        const at = `line ${index + 1}`;
        let raw;
        try {
            raw = JSON.parse(line);
        }
        catch {
            return { ok: false, error: `${at} is not JSON: ${SWEEP_ROW_SHAPE}` };
        }
        if (!isSweepRow(raw)) {
            const older = isRowBody(raw) && !('proposedSize' in raw);
            const why = older ? 'holds no proposedSize, so an older version wrote it: sweep again on this version' : `is not a sweep row: ${SWEEP_ROW_SHAPE}`;
            return { ok: false, error: `${at} ${why}` };
        }
        const key = `${raw.team}/${raw.id}`;
        if (seen.has(key)) {
            return { ok: false, error: `${at} repeats ${key}: give each task one row` };
        }
        seen.add(key);
        rows.push(raw);
    }
    return { ok: true, value: rows };
}
/**
 * The fields of `task` a row would change. A goal the task already serves through a key result needs no new tag. A size
 * is new only when a person changed it from the row's `proposedSize` (T2114): a stored size outranks a like-task median
 * and the default, so storing a proposal would freeze them, and the size a task reads as now cannot tell a proposal from
 * a correction, as it drifts from the row while a person reviews it. A size the task already stores is no change either,
 * so applying a corrected row twice leaves the task's size base where the first write put it.
 */
export function changesOf(row, task, goals) {
    const { objective, size, proposedSize } = row;
    const served = objective === null || task.goals.some((tag) => tag === objective || chainOf(tag, goals).some((goal) => goal.tag === objective));
    return {
        ...(row.class === task.workClass ? {} : { workClass: row.class }),
        ...(served ? {} : { goals: [...task.goals, objective] }),
        ...(size === null || size === proposedSize || size === task.size ? {} : { size }),
    };
}
/**
 * The fate of one row. `task` is undefined when the register lacks it. A finished task is refused, not skipped: a
 * person said yes to it, so they hear why it did not land.
 */
export function planSweepRow(row, task, goals, judge) {
    if (row.confirm !== SWEEP_CONFIRMED) {
        return { row, action: 'unconfirmed' };
    }
    if (task === undefined) {
        return { row, action: 'refused', reason: `no task ${row.id} in team ${row.team}` };
    }
    if (!ACTIVE_STATUSES.includes(task.status)) {
        return { row, action: 'refused', reason: `${row.id} is ${task.status} now` };
    }
    const changes = changesOf(row, task, goals);
    if (Object.keys(changes).length === 0) {
        return { row, action: 'unchanged' };
    }
    const reason = judge(task, changes);
    return reason === undefined ? { row, action: 'change', changes } : { row, action: 'refused', reason };
}
/** The fate of a row whose whole team is closed to the caller: refused, unless nobody confirmed it. */
export function refusedPlan(row, reason) {
    return row.confirm === SWEEP_CONFIRMED ? { row, action: 'refused', reason } : { row, action: 'unconfirmed' };
}
export function tallyOf(plans) {
    const count = (action) => plans.filter((plan) => plan.action === action).length;
    return { inserted: 0, changed: count('change'), unchanged: count('unchanged'), unconfirmed: count('unconfirmed'), refused: count('refused') };
}
/** One line naming what a change writes, for the dry run and the write alike. */
export function changesText(changes) {
    const parts = [
        ...(changes.workClass === undefined ? [] : [`class ${changes.workClass}`]),
        ...(changes.goals === undefined ? [] : [`goals ${changes.goals.join(',')}`]),
        ...(changes.size === undefined ? [] : [`size ${String(changes.size)}`]),
    ];
    return parts.join(', ');
}
/** The counts as a line; `unconfirmed` and `refused` only when there are some. */
export function tallyText(tally) {
    const { inserted, changed, unchanged, unconfirmed, refused } = tally;
    const left = [...(unconfirmed > 0 ? [`unconfirmed ${String(unconfirmed)}`] : []), ...(refused > 0 ? [`refused ${String(refused)}`] : [])];
    return [`inserted ${String(inserted)}`, `changed ${String(changed)}`, `unchanged ${String(unchanged)}`, ...left].join(', ');
}
/** A row's line, for a dry run or (`wrote`) a write; a row left alone only counts, so it has none. */
export function planLine(plan, wrote) {
    const name = `${plan.row.team}/${plan.row.id}`;
    switch (plan.action) {
        case 'change':
            return `${wrote ? 'CHANGED' : 'WOULD CHANGE'} ${name}: ${changesText(plan.changes)}`;
        case 'refused':
            return `REFUSED ${name}: ${plan.reason}`;
        case 'unchanged':
        case 'unconfirmed':
            return undefined;
    }
}

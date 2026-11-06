function sum(values) {
    let total = 0;
    for (const value of values) {
        total += value;
    }
    return total;
}
/** The open turns of a session's transcripts that named a task. */
function namingTurns(state) {
    return Object.values(state.cursors)
        .map(({ turn }) => turn)
        .filter((turn) => turn.tasks.length > 0);
}
/** W per task on each UTC day of one session's usage: `byTask`, plus each open turn's held W split equally over the tasks it named. */
export function taskDaysOf(state) {
    const days = new Map();
    const add = (day, task, w) => {
        const tasks = days.get(day) ?? new Map();
        tasks.set(task, (tasks.get(task) ?? 0) + w);
        days.set(day, tasks);
    };
    for (const [day, tasks] of Object.entries(state.byTask)) {
        for (const [task, w] of Object.entries(tasks)) {
            add(day, task, w);
        }
    }
    for (const turn of namingTurns(state)) {
        for (const [day, w] of Object.entries(turn.held)) {
            for (const task of turn.tasks) {
                add(day, task, w / turn.tasks.length);
            }
        }
    }
    return days;
}
/** W per UTC day on `task` in one session's usage, its open turns' share included. */
function daysOf(state, task) {
    const days = new Map();
    for (const [day, tasks] of taskDaysOf(state)) {
        const w = tasks.get(task);
        if (w !== undefined) {
            days.set(day, w);
        }
    }
    return days;
}
/** The W the meter keeps on `task`, per session, from each session's usage by its id. */
export function taskUseOf(bySession, task) {
    const sessions = [];
    for (const [session, state] of bySession) {
        const days = daysOf(state, task);
        if (days.size > 0) {
            const byDay = Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b)));
            sessions.push({ session, byDay, w: sum(days.values()) });
        }
    }
    sessions.sort((a, b) => b.w - a.w);
    return { task, sessions, w: sum(sessions.map((session) => session.w)) };
}
/** The W of a UTC day a session's turns put on some task, its open turns that named one included. */
export function attributedW(state, day) {
    return sum(Object.values(state.byTask[day] ?? {})) + sum(namingTurns(state).map((turn) => turn.held[day] ?? 0));
}

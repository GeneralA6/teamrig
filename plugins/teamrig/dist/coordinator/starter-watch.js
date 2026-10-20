import { isClaudeProcess } from "../open/session-processes.js";
/**
 * How often a watch looks: one signal 0 per starter, cheap enough to run through a whole step, and soon enough that a
 * step left behind frees the host lock and its memory within seconds.
 */
export const STARTER_CHECK_MS = 5_000;
export const nodeEvery = (everyMs, check) => {
    const timer = setInterval(check, everyMs);
    timer.unref();
    return () => clearInterval(timer);
};
/**
 * The processes worth watching: the ones that started this one (`lineage` past its first entry), up to and with the
 * nearest Claude Code, since what runs above it (a terminal, the desktop) ends a tab only through it; with no Claude
 * Code among them, as in a person's own terminal, every one.
 */
export function startersOf(lineage) {
    const starters = lineage.slice(1);
    const claude = starters.findIndex(isClaudeProcess);
    return claude === -1 ? starters : starters.slice(0, claude + 1);
}
/** The starter a watch found ended, as `bash.exe 4100`; while every one runs, `a process that started it`. */
export function endedText(watching) {
    const ended = watching.ended();
    return ended === undefined ? 'a process that started it' : `${ended.name} ${ended.pid}`;
}
/**
 * The watch over the system's processes: `lineage` once, then `alive` on each starter every `everyMs`. A starter whose
 * id another process took between two checks still looks alive; that only leaves the step to its time limit.
 */
export function starterWatch(processes, pid, every, everyMs = STARTER_CHECK_MS) {
    return {
        async watch() {
            const starters = startersOf((await processes.lineage(pid)) ?? []);
            const controller = new AbortController();
            let ended;
            let cancel = () => undefined;
            if (starters.length > 0) {
                cancel = every(everyMs, () => {
                    ended = starters.find((starter) => !processes.alive(starter.pid));
                    if (ended !== undefined) {
                        cancel();
                        controller.abort();
                    }
                });
            }
            return { starters, stop: controller.signal, ended: () => ended, close: () => cancel() };
        },
    };
}

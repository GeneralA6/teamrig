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
/** Where the launcher (plugins/teamrig/bin/teamrig) records, under Git Bash, the Windows ids of the shell that ran it and its own. */
export const SHELL_PID_ENV = 'TEAMRIG_SHELL_WINPID';
export const LAUNCHER_PID_ENV = 'TEAMRIG_LAUNCHER_WINPID';
/**
 * The shell that ran this process's launcher, as the launcher recorded it. Git Bash runs a command in a forked copy of
 * itself that ends once the launcher starts, so no process listing links the launcher to the shell; only the launcher
 * can name it. Undefined unless the launcher that recorded it is this process's own starter (`parentPid`): a process
 * that inherited an outer launcher's record from a step it runs was not started by that shell.
 */
export function launchingShellOf(env, parentPid) {
    const shell = Number(env[SHELL_PID_ENV]);
    return Number(env[LAUNCHER_PID_ENV]) === parentPid && Number.isSafeInteger(shell) && shell > 0 ? shell : undefined;
}
/**
 * The processes worth watching: the ones that started this one (`lineage` past its first entry), then the launching
 * shell's (`shellLineage`, from the shell up) where the first stops short of them, up to and with the nearest Claude
 * Code, since what runs above it (a terminal, the desktop) ends a tab only through it; with no Claude Code among them,
 * as in a person's own terminal, every one.
 */
export function startersOf(lineage, shellLineage = []) {
    const own = lineage.slice(1);
    const starters = [...own, ...shellLineage.filter((shell) => !own.some((starter) => starter.pid === shell.pid))];
    const claude = starters.findIndex(isClaudeProcess);
    return claude === -1 ? starters : starters.slice(0, claude + 1);
}
/** The starter a watch found ended, as `bash.exe 4100`; while every one runs, `a process that started it`. */
export function endedText(watching) {
    const ended = watching.ended();
    return ended === undefined ? 'a process that started it' : `${ended.name} ${ended.pid}`;
}
/**
 * The watch over the system's processes: `lineage` once for the process and once for its launching shell, then `alive`
 * on each starter every `everyMs`. A starter whose id another process took between two checks still looks alive; that
 * only leaves the step to its time limit.
 */
export function starterWatch(processes, watched, every, everyMs = STARTER_CHECK_MS) {
    return {
        async watch() {
            const [lineage, shellLineage] = await Promise.all([processes.lineage(watched.pid), watched.shell === undefined ? undefined : processes.lineage(watched.shell)]);
            const starters = startersOf(lineage ?? [], shellLineage ?? []);
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

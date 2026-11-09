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
 * Where the launcher (plugins/teamrig/bin/teamrig) records, under Git Bash, the Windows ids of the shells above it
 * (comma-separated, nearest first) and its own.
 */
export const SHELLS_PID_ENV = 'TEAMRIG_SHELL_WINPIDS';
export const LAUNCHER_PID_ENV = 'TEAMRIG_LAUNCHER_WINPID';
/**
 * The shells above this process's launcher, nearest first, as the launcher recorded them. Git Bash runs a command in a
 * forked copy of itself that ends once the command starts, so no process listing links the launcher to the shell that
 * ran it, and each shell one shell runs cuts the link once more (husky's hook runner runs the hook in `sh -e`, which
 * runs the launcher): only the launcher can name them, up to the first shell a Windows program started. That shell's
 * own starter may be gone as well (Git for Windows runs a `#!/usr/bin/env sh` hook through an env that execs the shell
 * and ends); its lineage goes on through the env stub that stays (`lineageOf`'s exec stub). Empty unless
 * the launcher that recorded them is this process's own starter (`parentPid`): a process that inherited an outer
 * launcher's record from a step it runs was not started by those shells.
 */
export function launchingShellsOf(env, parentPid) {
    if (Number(env[LAUNCHER_PID_ENV]) !== parentPid) {
        return [];
    }
    return (env[SHELLS_PID_ENV] ?? '')
        .split(',')
        .map(Number)
        .filter((shell) => Number.isSafeInteger(shell) && shell > 0);
}
/**
 * The processes worth watching: the ones that started this one (`lineage` past its first entry), then each launching
 * shell's in turn (`shellLineages`, nearest shell first, each from the shell up) where the lines before stop short of
 * them, up to and with the nearest Claude Code, since what runs above it (a terminal, the desktop) ends a tab only
 * through it; with no Claude Code among them, as in a person's own terminal, every one.
 */
export function startersOf(lineage, shellLineages = []) {
    const starters = lineage.slice(1);
    for (const shellLineage of shellLineages) {
        starters.push(...shellLineage.filter((shell) => !starters.some((starter) => starter.pid === shell.pid)));
    }
    const claude = starters.findIndex(isClaudeProcess);
    return claude === -1 ? starters : starters.slice(0, claude + 1);
}
/** The starter a watch found ended, as `bash.exe 4100`; while every one runs, `a process that started it`. */
export function endedText(watching) {
    const ended = watching.ended();
    return ended === undefined ? 'a process that started it' : `${ended.name} ${ended.pid}`;
}
/**
 * The watch over the system's processes: `lineage` once for the process and once for each launching shell, then `alive`
 * on each starter every `everyMs`. A starter whose id another process took between two checks still looks alive; that
 * only leaves the step to its time limit.
 */
export function starterWatch(processes, watched, every, everyMs = STARTER_CHECK_MS) {
    return {
        async watch() {
            const [lineage, ...shellLineages] = await Promise.all([watched.pid, ...watched.shells].map((pid) => processes.lineage(pid)));
            const starters = startersOf(lineage ?? [], shellLineages.map((shellLineage) => shellLineage ?? []));
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

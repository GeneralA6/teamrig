import { resolveDir } from "../push-guard/location.js";
import { hasLocalBin } from "./local-bin.js";
import { programsOf } from "./programs.js";
import { runnerCallOf } from "./runners.js";
/**
 * The ad-hoc package runs in a command line: each runner call that fetches a package, or that runs a bin not
 * installed where it runs (so the runner would fetch one). A habit guard, not a security boundary: a line built
 * at run time (`eval "$X"`) or a runner started by another program is not seen.
 */
/** True when `call` would fetch: always for a `fetch`, and for a `bin` not installed where it runs or in a folder only known then. */
async function fetches(files, run, call, home) {
    if (call.kind !== 'bin') {
        return call.kind === 'fetch';
    }
    const prefix = call.prefix;
    const dir = prefix === undefined ? run.dir : prefix.dynamic ? undefined : resolveDir(run.dir, prefix.text, home);
    return dir === undefined || !(await hasLocalBin(files, dir, call.bin));
}
/** The ad-hoc runner calls `command` makes, each once, as they show in a refusal (`npx eslint`). */
export async function adHocCallsOf(command, context, files) {
    const calls = new Set();
    for (const run of programsOf(command, context)) {
        const call = runnerCallOf(run);
        if (call.kind !== 'none' && (await fetches(files, run, call, context.home))) {
            calls.add(call.call);
        }
    }
    return [...calls];
}

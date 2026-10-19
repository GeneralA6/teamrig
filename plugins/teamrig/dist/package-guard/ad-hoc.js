import { resolveDir } from "../push-guard/location.js";
import { hasLocalBin } from "./local-bin.js";
import { programsOf } from "./programs.js";
import { runnerCallOf } from "./runners.js";
/** True when `call` would fetch: always for a `fetch`, and for a `bin` not installed where it runs or in a folder only known then. */
async function fetches(files, run, call, home) {
    if (call.kind === 'fetch') {
        return true;
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
        if ((call.kind === 'fetch' || call.kind === 'bin') && (await fetches(files, run, call, context.home))) {
            calls.add(call.call);
        }
    }
    return [...calls];
}

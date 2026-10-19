import { programsOf } from "./programs.js";
import { runnerCallOf } from "./runners.js";
/** The npx calls in `command` that hand their bin's flag to npm, each once. Like the ad-hoc read, it sees only this line. */
export function lostFlagsOf(command, context) {
    const lost = new Map();
    for (const run of programsOf(command, context)) {
        const call = runnerCallOf(run);
        if (call.kind === 'lost-flag') {
            lost.set(`${call.bin} ${call.flag}`, { bin: call.bin, flag: call.flag });
        }
    }
    return [...lost.values()];
}

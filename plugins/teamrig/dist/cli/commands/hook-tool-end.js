import { isRecord } from "../../core/guards.js";
import { noPositionals } from "../args.js";
import { EXIT } from "../runtime.js";
import { parseJson } from "./hook-input.js";
import { trackRestore } from "./hook-restore-track.js";
import { tabStatusOutputOf } from "./hook-tab-status.js";
/**
 * PostToolUse and PostToolUseFailure, every tool: the tab's title (`hook tab-status`) and the session's restore
 * entry (`hook restore-track`) from one process, since a tool's end is the most frequent hook event. The entry is
 * written at most every few minutes (`TOOL_END_WRITE_MS`), so through a long turn it shows the session's hooks
 * still run. It prints the title's terminal sequence or nothing, and on any error exits 0: it never holds up a turn.
 */
export async function toolEnd(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    if (!isRecord(payload)) {
        return EXIT.ok;
    }
    const [output] = await Promise.all([tabStatusOutputOf(runtime, payload).catch(() => ''), trackRestore(payload, runtime).catch(() => undefined)]);
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}

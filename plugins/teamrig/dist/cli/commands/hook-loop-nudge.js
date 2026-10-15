import { isRecord, recordField, stringField } from "../../core/guards.js";
import { chainOf, nudgeLine, nudgeOutput } from "../../hooks/loop-nudge.js";
import { TRANSCRIPT_TAIL_BYTES } from "../../names/title.js";
import { noPositionals } from "../args.js";
import { openKit } from "../kit.js";
import { EXIT } from "../runtime.js";
import { parseJson, sessionTeam } from "./hook-input.js";
/** The tool the hook fires for, from its payload; undefined without an id or a name. */
function currentToolOf(payload) {
    const id = stringField(payload, 'tool_use_id');
    const name = stringField(payload, 'tool_name');
    const input = recordField(payload, 'tool_input');
    return id === undefined || name === undefined ? undefined : { id, name, command: input === undefined ? undefined : stringField(input, 'command') };
}
/** The nudge line for this payload, or undefined: a helper's call, no team, the nudge off, or no run at the threshold. */
async function loopNudgeLine(payload, runtime) {
    const transcript = isRecord(payload) ? stringField(payload, 'transcript_path') : undefined;
    if (!isRecord(payload) || transcript === undefined || stringField(payload, 'agent_id') !== undefined) {
        return undefined;
    }
    const found = await sessionTeam(payload, runtime);
    const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
    const at = kit?.load.status === 'loaded' ? kit.load.config.loops.chainNudgeAt : 0;
    const text = at > 0 ? await runtime.files.readTail(transcript, TRANSCRIPT_TAIL_BYTES) : undefined;
    return text === undefined ? undefined : nudgeLine(chainOf(text, Buffer.byteLength(text, 'utf8') >= TRANSCRIPT_TAIL_BYTES, currentToolOf(payload)), at);
}
/**
 * PostToolUse on reads, edits and shell calls: once a turn's run of single-step calls reaches
 * `loops.chainNudgeAt`, hands the model one line asking it to batch, priced in re-reads. A helper's
 * calls (the payload has `agent_id`) are skipped, since the run counts the main thread only. Outside
 * a loaded team, with the nudge off or on any error it prints nothing.
 */
export async function loopNudge(args, runtime) {
    noPositionals(args);
    const line = await loopNudgeLine(parseJson(await runtime.readStdin()), runtime).catch(() => undefined);
    if (line !== undefined) {
        runtime.out.stdout(nudgeOutput(line));
    }
    return EXIT.ok;
}

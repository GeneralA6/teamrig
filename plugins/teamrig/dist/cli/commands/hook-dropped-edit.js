import { isRecord, stringField } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { droppedEditReason, droppedEditsOf } from "../../hooks/dropped-edit.js";
import { blockOutput } from "../../hooks/stop.js";
import { TRANSCRIPT_TAIL_BYTES } from "../../names/title.js";
import { noPositionals } from "../args.js";
import { EXIT } from "../runtime.js";
import { parseJson, sessionTeam } from "./hook-input.js";
/**
 * How much of a helper's own transcript a SubagentStop reads: past the largest seen (15 MB), so a
 * helper's whole run is checked, not only its last calls. A session's turn is its transcript's tail.
 */
export const HELPER_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
/**
 * The instruction for an agent whose turn ends with a refused skill edit it never redid (dropped-edit.ts);
 * none on a stop this hook already blocked (so it asks once), without the transcript or when none was
 * dropped. `thread` picks the transcript: the session's (`transcript_path`) or the helper's own
 * (`agent_transcript_path`).
 */
export async function droppedEditReasonOf(runtime, payload, thread) {
    const transcript = stringField(payload, thread === 'main' ? 'transcript_path' : 'agent_transcript_path');
    if (payload['stop_hook_active'] === true || transcript === undefined) {
        return undefined;
    }
    const bytes = thread === 'main' ? TRANSCRIPT_TAIL_BYTES : HELPER_TRANSCRIPT_BYTES;
    const text = await runtime.files.readTail(transcript, bytes);
    const dropped = text === undefined ? [] : droppedEditsOf(text, Buffer.byteLength(text, 'utf8') >= bytes, thread);
    return dropped.length === 0 ? undefined : droppedEditReason(dropped, KIT_NAME);
}
/** The SubagentStop's reason for this payload; none outside a team. */
async function helperReasonOf(runtime, payload) {
    return (await sessionTeam(payload, runtime)).kind === 'team' ? droppedEditReasonOf(runtime, payload, 'helper') : undefined;
}
/**
 * SubagentStop, when a helper is about to hand back: a skill edit of its run that Claude Code refused
 * and it never redid sends it back once, to read the file again and redo the change, or to say why it
 * dropped it; a helper's report otherwise reads as done while the change is lost. Outside a team, on
 * the stop it already blocked, for input that is not a hook payload or on any error, it prints nothing.
 */
export async function subagentStop(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const reason = isRecord(payload) ? await helperReasonOf(runtime, payload).catch(() => undefined) : undefined;
    if (reason !== undefined) {
        runtime.out.stdout(blockOutput(reason));
    }
    return EXIT.ok;
}

import { KIT_NAME } from "../../core/home.js";
import { droppedEditReason, droppedEditsOf } from "../../hooks/dropped-edit.js";
import { blockReply } from "../../hooks/stop.js";
import { TRANSCRIPT_TAIL_BYTES } from "../../names/title.js";
import { noPositionals } from "../args.js";
import { transcriptsOf } from "../host.js";
import { EXIT } from "../runtime.js";
import { readHookInput, sessionTeam, writeReply } from "./hook-input.js";
/**
 * How much of a helper's own transcript a SubagentStop reads: past the largest seen (15 MB), so a
 * helper's whole run is checked, not only its last calls. A session's turn is its transcript's tail.
 */
export const HELPER_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
/**
 * The instruction for an agent whose turn ends with a refused skill edit it never redid (dropped-edit.ts);
 * none on a stop this hook already blocked (so it asks once), without the transcript or when none was
 * dropped. `thread` picks the transcript the event names: the session's or the helper's own.
 */
export async function droppedEditReasonOf(runtime, event, thread) {
    const transcript = thread === 'main' ? event.transcript : event.helper?.transcript;
    if (event.stopActive || transcript === undefined) {
        return undefined;
    }
    const bytes = thread === 'main' ? TRANSCRIPT_TAIL_BYTES : HELPER_TRANSCRIPT_BYTES;
    const text = await runtime.files.readTail(transcript, bytes);
    const dropped = text === undefined ? [] : droppedEditsOf(transcriptsOf(runtime), text, Buffer.byteLength(text, 'utf8') >= bytes, thread);
    return dropped.length === 0 ? undefined : droppedEditReason(dropped, KIT_NAME);
}
/** The SubagentStop's reason for this event; none outside a team. */
async function helperReasonOf(runtime, event) {
    return (await sessionTeam(event.cwd, runtime)).kind === 'team' ? droppedEditReasonOf(runtime, event, 'helper') : undefined;
}
/**
 * SubagentStop, when a helper is about to hand back: a skill edit of its run that Claude Code refused
 * and it never redid sends it back once, to read the file again and redo the change, or to say why it
 * dropped it; a helper's report otherwise reads as done while the change is lost. Outside a team, on
 * the stop it already blocked, for input that is not a hook payload or on any error, it prints nothing.
 */
export async function subagentStop(args, runtime) {
    noPositionals(args);
    const { event } = await readHookInput(runtime);
    const reason = event === undefined ? undefined : await helperReasonOf(runtime, event).catch(() => undefined);
    writeReply(runtime, 'helper-stop', reason === undefined ? undefined : blockReply(reason));
    return EXIT.ok;
}

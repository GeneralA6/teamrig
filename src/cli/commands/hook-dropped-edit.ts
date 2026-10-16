import { isRecord, stringField, type JsonRecord } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { droppedEditReason, droppedEditsOf, type TranscriptThread } from '../../hooks/dropped-edit.ts';
import { blockOutput } from '../../hooks/stop.ts';
import { TRANSCRIPT_TAIL_BYTES } from '../../names/title.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson, sessionTeam } from './hook-input.ts';

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
export async function droppedEditReasonOf(runtime: CliRuntime, payload: JsonRecord, thread: TranscriptThread): Promise<string | undefined> {
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
async function helperReasonOf(runtime: CliRuntime, payload: JsonRecord): Promise<string | undefined> {
  return (await sessionTeam(payload, runtime)).kind === 'team' ? droppedEditReasonOf(runtime, payload, 'helper') : undefined;
}

/**
 * SubagentStop, when a helper is about to hand back: a skill edit of its run that Claude Code refused
 * and it never redid sends it back once, to read the file again and redo the change, or to say why it
 * dropped it; a helper's report otherwise reads as done while the change is lost. Outside a team, on
 * the stop it already blocked, for input that is not a hook payload or on any error, it prints nothing.
 */
export async function subagentStop(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const reason = isRecord(payload) ? await helperReasonOf(runtime, payload).catch((): string | undefined => undefined) : undefined;
  if (reason !== undefined) {
    runtime.out.stdout(blockOutput(reason));
  }
  return EXIT.ok;
}

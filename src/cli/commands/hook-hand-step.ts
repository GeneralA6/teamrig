import { KIT_NAME } from '../../core/home.ts';
import { handStepLintReason } from '../../hooks/hand-step-lint.ts';
import type { HookEvent } from '../../ports/host/index.ts';
import { REPLY_TAIL_BYTES, replyOf } from '../../turn-log/reply.ts';
import { transcriptsIfKept } from '../host.ts';
import type { CliRuntime } from '../runtime.ts';

/** What the lint reads of a turn end's hook event. */
type TurnEnd = Pick<HookEvent, 'transcript' | 'lastReply' | 'stopActive'>;

/**
 * The text the person saw this turn: the model's text since the turn's start in the transcript's tail, and the
 * last reply the turn end's hook event names, which the transcript may not hold yet. A copy of it twice changes
 * nothing the lint reads. On a host whose transcript teamrig cannot read, that last reply alone.
 */
async function turnTextOf(runtime: CliRuntime, { transcript, lastReply }: TurnEnd): Promise<string> {
  const reader = transcriptsIfKept(runtime);
  const tail = reader === undefined || transcript === undefined ? undefined : await runtime.files.readTail(transcript, REPLY_TAIL_BYTES);
  const reply = reader === undefined || tail === undefined ? undefined : replyOf(reader, tail, undefined, Buffer.byteLength(tail, 'utf8') < REPLY_TAIL_BYTES);
  return [reply?.text, lastReply].filter((part) => part !== undefined).join('\n\n');
}

/**
 * The instruction for a team session whose turn handed the human a shell or JSON block or a call line with no pinned
 * sha256 (hand-step-lint.ts, core rule 11); none on a stop a hook already sent back, so a turn is asked once and a
 * reply that says the block only reads ends it.
 */
export async function handStepReasonOf(runtime: CliRuntime, event: TurnEnd): Promise<string | undefined> {
  if (event.stopActive) {
    return undefined;
  }
  return handStepLintReason(await turnTextOf(runtime, event), KIT_NAME);
}

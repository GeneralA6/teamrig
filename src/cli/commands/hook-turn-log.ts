import type { KitConfig } from '../../config/types.ts';
import { stringField, type JsonRecord } from '../../core/guards.ts';
import type { TeamPaths } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import type { HookEvent } from '../../ports/host/index.ts';
import { cappedText, type TurnLogEntry, type TurnLogKind } from '../../turn-log/entry.ts';
import { REPLY_TAIL_BYTES, replyOf, type Reply } from '../../turn-log/reply.ts';
import { TurnLog } from '../../turn-log/store.ts';
import { WakePrompts } from '../../wake/prompts.ts';
import { transcriptsIfKept } from '../host.ts';
import type { CliRuntime } from '../runtime.ts';

/** The team session a hook logs for. */
export interface TurnLogScope {
  readonly config: KitConfig;
  readonly paths: Pick<TeamPaths, 'turnLog' | 'wake'>;
  readonly id: string;
}

/** What one entry says, before its text is redacted and capped. */
interface Said {
  readonly kind: TurnLogKind;
  readonly claude: string;
  readonly text: string;
  readonly cut?: boolean;
  readonly upTo?: string;
  readonly from?: 'teamrig';
}

/** What a session start's `source` logs: a /clear or a compaction, which wipe what the tab showed. */
const WIPES: Readonly<Record<string, string>> = { clear: 'context cleared (/clear)', compact: 'context compacted' };

function entryOf(runtime: CliRuntime, scope: TurnLogScope, said: Said): TurnLogEntry {
  const { text, cut } = cappedText(new SecretScanner(scope.config.register.secretPatterns).redact(said.text));
  return {
    at: new Date(runtime.clock.now()).toISOString(),
    kind: said.kind,
    text,
    claude: said.claude,
    ...(cut || said.cut === true ? { truncated: true } : {}),
    ...(said.upTo === undefined ? {} : { upTo: said.upTo }),
    ...(said.from === undefined ? {} : { from: said.from }),
  };
}

function logOf(runtime: CliRuntime, scope: TurnLogScope): TurnLog {
  return new TurnLog(runtime.files, scope.paths.turnLog);
}

/**
 * UserPromptSubmit: the prompt the person sent, or the wake teamrig submitted in that tab, marked `from: teamrig`;
 * nothing with the log off or an empty prompt.
 */
export async function logPrompt(runtime: CliRuntime, scope: TurnLogScope, { session, prompt }: Pick<HookEvent, 'session' | 'prompt'>): Promise<void> {
  if (!scope.config.turnLog.enabled || session === undefined || prompt === undefined || prompt.trim() === '') {
    return;
  }
  const woke = await new WakePrompts(runtime.files, scope.paths.wake).take(scope.id, { tab: session, text: prompt });
  const said: Said = { kind: 'prompt', claude: session, text: prompt, ...(woke ? { from: 'teamrig' } : {}) };
  await logOf(runtime, scope).append(scope.id, entryOf(runtime, scope, said));
}

/** A reply to log: its text, whether its start is missing, and the last transcript entry it took, when known. */
interface ReplyText {
  readonly text: string;
  readonly cut: boolean;
  readonly upTo: string | undefined;
}

/**
 * The turn's reply from the transcript, ending with the message Claude Code gives the Stop hook
 * (`last_assistant_message`) when the transcript does not hold it yet; undefined when the turn wrote no text.
 * A reply of that message alone keeps `after`, the last entry an earlier reply took.
 */
function replyWithLast(reply: Reply | undefined, last: string | undefined, after: string | undefined): ReplyText | undefined {
  const base = reply === undefined ? undefined : { text: reply.text, cut: reply.cut, upTo: reply.upTo };
  const message = last?.trim();
  if (message === undefined || message === '' || base?.text.trimEnd().endsWith(message) === true) {
    return base;
  }
  return base === undefined ? { text: message, cut: false, upTo: after } : { ...base, text: `${base.text}\n\n${message}` };
}

/**
 * Stop: the reply the person saw since the last one logged. A stop that a hook sent back (`stop_hook_active`)
 * ends part of a turn, so a later stop of the same turn starts after the last entry this one took (`upTo`). On a
 * host whose transcript teamrig cannot read, the reply is the Stop hook's last message alone.
 */
export async function logReply(runtime: CliRuntime, scope: TurnLogScope, payload: JsonRecord): Promise<void> {
  const claude = sessionIdOf(payload);
  if (!scope.config.turnLog.enabled || claude === null) {
    return;
  }
  const log = logOf(runtime, scope);
  const last = await log.last(scope.id);
  const after = last?.kind === 'reply' && last.claude === claude ? last.upTo : undefined;
  const reader = transcriptsIfKept(runtime);
  const transcript = reader === undefined ? undefined : stringField(payload, 'transcript_path');
  const tail = transcript === undefined ? undefined : await runtime.files.readTail(transcript, REPLY_TAIL_BYTES);
  const fromTranscript = reader === undefined || tail === undefined ? undefined : replyOf(reader, tail, after, Buffer.byteLength(tail, 'utf8') < REPLY_TAIL_BYTES);
  const reply = replyWithLast(fromTranscript, stringField(payload, 'last_assistant_message'), after);
  if (reply === undefined) {
    return;
  }
  const { text, cut, upTo } = reply;
  await log.append(scope.id, entryOf(runtime, scope, { kind: 'reply', claude, text, cut, ...(upTo === undefined ? {} : { upTo }) }));
}

/**
 * SessionStart: marks a /clear or a compaction, which wipe what the tab showed, and removes every session's
 * hours past `turnLog.keepHours` (folder listings only).
 */
export async function logStart(runtime: CliRuntime, scope: TurnLogScope, { session, source }: Pick<HookEvent, 'session' | 'source'>): Promise<void> {
  if (!scope.config.turnLog.enabled) {
    return;
  }
  const log = logOf(runtime, scope);
  const wipe = source === undefined ? undefined : WIPES[source];
  if (session !== undefined && wipe !== undefined) {
    await log.append(scope.id, entryOf(runtime, scope, { kind: 'clear', claude: session, text: wipe }));
  }
  await log.prune(runtime.clock.now(), scope.config.turnLog.keepHours);
}

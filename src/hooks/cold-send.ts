import type { Files } from '../core/files.ts';
import { stringField } from '../core/guards.ts';
import { hostSessionOf } from '../core/host-session.ts';
import { parseJsonl, toJsonlLine } from '../core/jsonl.ts';
import type { HookEvent } from '../ports/host/index.ts';

/**
 * The cold-send hook, PreToolUse on SendMessage. A message wakes its receiver, and a receiver idle
 * past Claude Code's prompt cache wakes cold: its first call re-reads its whole context at full
 * price, about eight times a warm wake. So a message to a team session idle `coldAfterMinutes` or
 * longer is held once, with a note to write an inbox line instead (with wakes on, marked `--wake now`
 * when the receiver must act now, so lines posted together wake it once), or to send it again: the
 * same tab's next send to it within RESEND_WINDOW_MS goes through. With wakes on that resend is kept
 * for a live back-and-forth; with them off it carries every ask for that session.
 */

export const COLD_SEND_VERSION = 1;
/** How long after a hold the same tab's send to the same session goes through. */
export const RESEND_WINDOW_MS = 15 * 60 * 1000;
/** How much of the hold log is read: far more than one resend window's holds, never the whole log. */
export const COLD_SEND_TAIL_BYTES = 64 * 1024;

/** A message a call sends to another agent: the receiver it names and its text, empty for a call with none (a pure idle subscription). */
export interface SentMessage {
  readonly to: string;
  readonly text: string;
}

/** The message this event's call sends; undefined for a call of any other kind or one naming no receiver. */
export function sentMessageOf(event: HookEvent): SentMessage | undefined {
  const { call } = event;
  return call?.kind !== 'message' || call.to === undefined ? undefined : { to: call.to, text: call.text ?? '' };
}

/** Whether a session idle `idleMs` wakes cold; `coldAfterMinutes` 0 never does. */
export function isCold(idleMs: number, coldAfterMinutes: number): boolean {
  return coldAfterMinutes > 0 && idleMs >= coldAfterMinutes * 60_000;
}

/** The holds the hook made, by sending tab and receiving session. */
export interface ColdSendLog {
  /** Whether this tab's send to `to` was held at or after `since`. */
  heldSince(claudeSession: string, to: string, since: Date): Promise<boolean>;
  record(claudeSession: string, to: string, at: Date): Promise<void>;
}

/**
 * `cold-sends.jsonl`: one `{"v":1,"claudeSession":"…","to":"…","at":"…"}` line per hold. A later teamrig's line
 * names the tab `hostSession`, and its hold counts here too: both share the log until every tab has reloaded.
 */
export class JsonlColdSendLog implements ColdSendLog {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  /** Read from the log's tail, so its size never slows a send; a damaged line is skipped. */
  async heldSince(claudeSession: string, to: string, since: Date): Promise<boolean> {
    const { records } = parseJsonl((await this.files.readTail(this.path, COLD_SEND_TAIL_BYTES)) ?? '');
    return records.some((line) => {
      const at = Date.parse(stringField(line.record, 'at') ?? '');
      return hostSessionOf(line.record, 'claudeSession') === claudeSession && stringField(line.record, 'to') === to && at >= since.getTime();
    });
  }

  async record(claudeSession: string, to: string, at: Date): Promise<void> {
    await this.files.append(this.path, toJsonlLine({ v: COLD_SEND_VERSION, claudeSession, to, at: at.toISOString() }));
  }
}

export interface ColdSendFacts {
  /** The sending tab. */
  readonly claudeSession: string;
  /** The receiving session's id and the name it is messaged by. */
  readonly to: string;
  readonly name: string;
  /** How long the receiver has been idle: since its last transcript write. */
  readonly idleMs: number;
  readonly coldAfterMinutes: number;
  readonly now: Date;
  /** The command name the note tells the sender to run. */
  readonly command: string;
  /** Whether an inbox line can wake the receiver (`wake.enabled`), so the note offers `--wake now`. */
  readonly wakeNow: boolean;
}

export type ColdSendVerdict = { readonly kind: 'send' } | { readonly kind: 'hold'; readonly reason: string };

const SEND: ColdSendVerdict = { kind: 'send' };

export function coldSendReason(facts: ColdSendFacts): string {
  const minutes = Math.floor(facts.idleMs / 60_000);
  const window = RESEND_WINDOW_MS / 60_000;
  const held = `Held once: ${facts.name} has been idle ${minutes} min, so this message would wake it cold (its first call re-reads its whole context at full price, about 8 times a warm wake). `;
  const line = `${facts.command} inbox add --to ${facts.to} --text "..."`;
  if (!facts.wakeNow) {
    return (
      held +
      `If it need not act now (no blocker, incident, decision or same-area conflict), write one inbox line instead: ${line}. ` +
      `If it must go now, put every ask you have for ${facts.name} in this one message and send it again: a send to it within ${window} min goes through.`
    );
  }
  return (
    held +
    `Write it as one inbox line instead: ${line}, with --wake now if it must act now (a blocker, incident, decision or same-area conflict), so lines posted together wake it once. ` +
    `Only for a live back-and-forth, send it again: a send to it within ${window} min goes through.`
  );
}

/**
 * Send or hold. A cold receiver's first send from a tab is held and recorded; the tab's next send
 * to it within the window goes. A log that cannot be read or written never holds a message: the
 * hold saves tokens, and a send held for good would cost a blocker.
 */
export async function decideColdSend(log: ColdSendLog, facts: ColdSendFacts): Promise<ColdSendVerdict> {
  if (!isCold(facts.idleMs, facts.coldAfterMinutes)) {
    return SEND;
  }
  try {
    if (await log.heldSince(facts.claudeSession, facts.to, new Date(facts.now.getTime() - RESEND_WINDOW_MS))) {
      return SEND;
    }
    await log.record(facts.claudeSession, facts.to, facts.now);
  } catch {
    return SEND;
  }
  return { kind: 'hold', reason: coldSendReason(facts) };
}

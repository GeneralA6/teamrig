import { join } from 'node:path';
import type { Files } from './files.ts';
import { stringField } from './guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from './jsonl.ts';

/**
 * A one-time ask a command records for a session and that session's Stop hook turns into one block: `set` writes
 * it when a task change calls for it, the hook removes it before it asks. The ask for a hired session's handover
 * (hiring/retire-ask.ts) and the keep-working ask (wake/keep-working.ts) each keep their own folder of them.
 */

export const SESSION_ASK_FORMAT = 1;

/** A due ask: the task whose change called for it, and when. */
export interface SessionAsk {
  readonly task: string;
  readonly at: string;
}

/** An ask file's content; undefined when it is damaged or from another format. */
export function parseSessionAsk(text: string): SessionAsk | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== SESSION_ASK_FORMAT) {
    return undefined;
  }
  const task = stringField(record, 'task');
  const at = stringField(record, 'at');
  return task === undefined || at === undefined ? undefined : { task, at };
}

export function formatSessionAsk(ask: SessionAsk): string {
  return toJsonlLine({ [VERSION_FIELD]: SESSION_ASK_FORMAT, task: ask.task, at: ask.at });
}

/** The due asks of one kind, one small file per session (`<id>.json`). Ids are session ids, checked by the roster, so they are safe in a path. */
export class SessionAskStore {
  private readonly files: Files;
  private readonly folder: string;

  constructor(files: Files, folder: string) {
    this.files = files;
    this.folder = folder;
  }

  /** The session's due ask; none when there is none or its file is damaged. */
  async get(id: string): Promise<SessionAsk | undefined> {
    const text = await this.files.read(this.pathOf(id));
    return text === undefined ? undefined : parseSessionAsk(text);
  }

  async set(id: string, ask: SessionAsk): Promise<void> {
    await this.files.write(this.pathOf(id), formatSessionAsk(ask));
  }

  async clear(id: string): Promise<void> {
    await this.files.remove(this.pathOf(id));
  }

  private pathOf(id: string): string {
    return join(this.folder, `${id}.json`);
  }
}

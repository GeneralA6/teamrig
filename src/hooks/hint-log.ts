import { stringField } from '../core/guards.ts';
import { parseJsonl, toJsonlLine } from '../core/jsonl.ts';
import type { LogFile } from '../core/log-file.ts';

export const HINT_VERSION = 1;

/**
 * The hints the hooks already gave, so each is given once per Claude Code session: the prompt hook's
 * bind hints (once for a tab with no title, once more for each title that binds nothing) and the
 * session start's note of missing requirements.
 */
export interface HintLog {
  shown(claudeSession: string, reason: string): Promise<boolean>;
  record(claudeSession: string, reason: string, at: Date): Promise<void>;
}

/** `bind-hints.jsonl`: one `{"v":1,"claudeSession":"…","reason":"…","at":"…"}` line per hint given. */
export class JsonlHintLog implements HintLog {
  private readonly log: LogFile;

  constructor(log: LogFile) {
    this.log = log;
  }

  /** A line of any version naming the session and reason counts: a newer teamrig gave that hint too. */
  async shown(claudeSession: string, reason: string): Promise<boolean> {
    const { records } = parseJsonl((await this.log.read()) ?? '');
    return records.some((line) => stringField(line.record, 'claudeSession') === claudeSession && stringField(line.record, 'reason') === reason);
  }

  async record(claudeSession: string, reason: string, at: Date): Promise<void> {
    await this.log.append(toJsonlLine({ v: HINT_VERSION, claudeSession, reason, at: at.toISOString() }));
  }
}

/**
 * Whether the hint prints now: the first time for this Claude Code session and reason, recorded
 * before it prints. A log that cannot be read or written never silences the hint: it prints again.
 */
export async function firstHint(log: HintLog, claudeSession: string, reason: string, now: Date): Promise<boolean> {
  try {
    if (await log.shown(claudeSession, reason)) {
      return false;
    }
    await log.record(claudeSession, reason, now);
  } catch {
    // The hint is one short line: shown again beats never shown.
  }
  return true;
}

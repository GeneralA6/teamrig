import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { ShellEnd } from '../core/shell-end.ts';
import { cleanOutput } from './parse.ts';

/** How many logs are kept for each session (and for runs with no session); older ones are removed. */
export const KEPT_LOGS = 20;

const SUFFIX = '.log';

/** The start of every log name of a session, or of runs with no session: `test-<session>-` or `test-`. */
function prefixOf(session: string | null): string {
  return session === null ? 'test-' : `test-${session}-`;
}

/** The run number in a log name, or undefined for another session's log or any other file. */
function numberOf(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix) || !name.endsWith(SUFFIX)) {
    return undefined;
  }
  const digits = name.slice(prefix.length, -SUFFIX.length);
  return /^\d+$/.test(digits) ? Number(digits) : undefined;
}

/** The run numbers of a session's logs in `dir`, newest first. */
async function runNumbers(files: Files, dir: string, prefix: string): Promise<number[]> {
  const numbers = (await files.list(dir)).map((name) => numberOf(name, prefix)).filter((n) => n !== undefined);
  return numbers.sort((a, b) => b - a);
}

/**
 * Creates the next log of a session (`session` null: of runs with no session), numbered one past its
 * newest, holding `firstText`; the run's output is appended to it when the run ends. Two runs that start together get different numbers,
 * since a name already taken moves on to the next.
 */
export async function reserveLog(files: Files, dir: string, session: string | null, firstText: string): Promise<string> {
  const prefix = prefixOf(session);
  const [newest = 0] = await runNumbers(files, dir, prefix);
  for (let next = newest + 1; ; next += 1) {
    const path = join(dir, `${prefix}${next}${SUFFIX}`);
    if (await files.createExclusive(path, firstText)) {
      return path;
    }
  }
}

/** Removes a session's logs past the newest `keep`. */
export async function pruneLogs(files: Files, dir: string, session: string | null, keep: number = KEPT_LOGS): Promise<void> {
  const prefix = prefixOf(session);
  for (const old of (await runNumbers(files, dir, prefix)).slice(keep)) {
    await files.remove(join(dir, `${prefix}${old}${SUFFIX}`));
  }
}

/** How the command ended, as the log's last line: `exit 1`, or `ended by SIGTERM`. */
export function endLine(end: ShellEnd): string {
  return end.kind === 'exited' ? `exit ${end.code}` : `ended by ${end.signal}`;
}

/** The first line of a log: the command line, as a shell prompt shows it. */
export function commandHeader(command: string): string {
  return `$ ${command}\n`;
}

/** The log's line for a run that stopped reading a pipe an orphaned process still held after the command ended. */
export const HELD_OPEN_LINE = 'a process the command started still held its output open after the command ended, so the run stopped reading it';

/**
 * A run's log after its command line, written as the output arrives: each whole line as it comes, cleaned as
 * `cleanOutput` cleans the whole output (a line's colour codes and `\r` rewrites stay within it), so a run that
 * hangs or is killed leaves every line it printed (#719). `end` adds the last part line and how the run ended.
 * Everything is appended, never written over the log: on Windows a file a reader or a virus scan holds open cannot
 * be replaced (T696).
 */
export class LiveLog {
  private readonly files: Files;
  private readonly path: string;
  private pending = '';
  private written: Promise<void> = Promise.resolve();
  private failure: { readonly error: unknown } | undefined;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  /** Takes a piece of output; the whole lines it completes go to the log, in order. */
  write(chunk: string): void {
    this.pending += chunk;
    const last = this.pending.lastIndexOf('\n');
    if (last !== -1) {
      this.append(cleanOutput(this.pending.slice(0, last + 1)));
      this.pending = this.pending.slice(last + 1);
    }
  }

  /** Writes the output's last part line, `heldOpen`'s line and how the run ended; throws the first write that failed. */
  async end(end: ShellEnd, heldOpen: boolean): Promise<void> {
    const rest = cleanOutput(this.pending);
    this.pending = '';
    this.append(`${rest === '' || rest.endsWith('\n') ? rest : `${rest}\n`}${heldOpen ? `${HELD_OPEN_LINE}\n` : ''}${endLine(end)}\n`);
    await this.written;
    if (this.failure !== undefined) {
      throw this.failure.error;
    }
  }

  private append(text: string): void {
    if (text === '') {
      return;
    }
    this.written = this.written.then(async () => {
      if (this.failure === undefined) {
        await this.files.append(this.path, text).catch((error: unknown) => {
          this.failure = { error };
        });
      }
    });
  }
}

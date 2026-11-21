import { spawn } from 'node:child_process';
import type { Env } from '../core/home.ts';
import { endOf, type ShellEnd } from '../core/shell-end.ts';
import { nodeTreeKill, type TreeKill } from '../delivery/tree-kill.ts';
import { posixQuote } from '../open/quote.ts';
import { silenceHostCpu, watchSilence, type SilenceHostCpu } from './silence.ts';

/** How a `teamrig test` run ended: as a shell command does, or stopped with every process it started after printing nothing for `silentMs` (#1532). */
export type TestEnd = ShellEnd | { readonly kind: 'idle'; readonly silentMs: number };

export interface ShellRequest {
  /** One command line, read by the platform's shell: `sh` on POSIX, `cmd.exe` on Windows. */
  readonly command: string;
  readonly cwd: string;
  readonly env: Env;
  /** Past this long with no output the command is stopped with every process it started; 0 never stops it. */
  readonly idleMs: number;
  /**
   * Output that starts the `idleMs` limit: until the command prints it, its silence is not timed. The host queue's line
   * for the step starting, so a queued run's wait for its turn is never taken for a hang; none times it from the start.
   */
  readonly idleFrom?: string;
}

export interface ShellResult {
  readonly end: TestEnd;
  /** What it printed on stdout and stderr together, in the order it arrived. */
  readonly output: string;
}

/** Runs a shell command line to its end, with no stdin, and keeps everything it printed. */
export interface ShellRunner {
  run(request: ShellRequest): Promise<ShellResult>;
}

/** Characters a POSIX shell reads as plain text; a word with any other is single-quoted. */
const POSIX_PLAIN = /^[\w@%+=:,./-]+$/;
/** Characters `cmd.exe` reads as syntax or a word break; a word with any of them is double-quoted. */
const CMD_SPECIAL = /[\s"&|<>^%!()]/;

/**
 * The command line for the words after `--`. One word is the line itself, so `"npm run build && npm test"`
 * runs as written. Several are joined, each quoted where the shell would read it, so a glob reaches the
 * program as typed and the shell never expands it.
 */
export function commandLine(words: readonly string[], platform: NodeJS.Platform): string {
  const [only] = words;
  if (words.length === 1 && only !== undefined) {
    return only;
  }
  return words.map((word) => (platform === 'win32' ? cmdWord(word) : posixWord(word))).join(' ');
}

/** A line break, where cmd.exe ends the line it runs. */
const LINE_BREAK = /[\r\n]/;

/** The chain operators a POSIX shell and cmd.exe both read, which `commandLine` quotes when it is a word of its own. */
const CHAIN_OPERATORS: readonly string[] = ['&&', '||', ';'];

/**
 * Why the platform's shell would not run these words as given, or undefined when it would. A blank command runs
 * nothing and exits 0 in every shell. Of several words, one that is only `&&`, `||` or `;` was meant as a chain, but
 * `commandLine` quotes it and the first program gets it as an argument, often after a long wait for the host lock
 * (#661): one word, the whole chain, runs as a shell line. cmd.exe ends its `/c` line at the first line break, and no
 * quoting keeps one, so on Windows only what comes before the break runs: a `bash -c` script that starts with one runs
 * nothing, exit 0. A POSIX shell keeps a quoted line break.
 */
export function unrunnableReason(words: readonly string[], platform: NodeJS.Platform): string | undefined {
  if (words.every((word) => word.trim() === '')) {
    return 'the command after -- is empty, and a shell runs an empty command as nothing, exit 0';
  }
  const operator = words.length > 1 ? words.find((word) => CHAIN_OPERATORS.includes(word)) : undefined;
  if (operator !== undefined) {
    return (
      `the word "${operator}" of the command is a shell operator, and of several words each is passed to the first program as is, ` +
      `so it would get "${operator}" as an argument; pass the whole chain as one quoted word: -- "${words.join(' ')}"`
    );
  }
  if (platform === 'win32' && words.some((word) => LINE_BREAK.test(word))) {
    return (
      'a word of the command holds a line break, and cmd.exe, which runs the command on Windows, stops reading at it: ' +
      'only what comes before it would run. Put a multi-line script in a file and run the file, or keep each word on one line'
    );
  }
  return undefined;
}

/** One word for a POSIX shell: as it is when the shell reads it as plain text, else single-quoted. */
export function posixWord(word: string): string {
  return POSIX_PLAIN.test(word) ? word : posixQuote(word);
}

function cmdWord(word: string): string {
  return word !== '' && !CMD_SPECIAL.test(word) ? word : `"${word.replaceAll('"', '\\"')}"`;
}

/** The signals that end this process from outside: Ctrl-C, a kill, and the terminal that started it closing. */
const ENDING_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Where the runner hears this process being ended, so it can end the command's group too: `process`, or a fake. */
export interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * The real shell: Node's `spawn` with `shell: true`, stdin closed, stdout and stderr read as they come. A command that
 * prints nothing for its `idleMs` is killed with every process it started, a busy host stretching the limit as in the
 * coverage gate. On POSIX it runs as its own process group so that kill ends the whole tree; a group the terminal no
 * longer signals is killed here when this process gets SIGINT, SIGTERM or SIGHUP (Ctrl-C, a kill, its terminal
 * closing). A SIGKILL to this process cannot be caught: it leaves the group running with no watch to stop it, as it
 * leaves a queue step's.
 */
export function nodeShellRunner(
  platform: NodeJS.Platform = process.platform,
  kill: TreeKill = nodeTreeKill(platform),
  cpu: SilenceHostCpu = silenceHostCpu(),
  signals: SignalSource = process,
): ShellRunner {
  const grouped = platform !== 'win32';
  return {
    run: async (request) => {
      const child = spawn(request.command, {
        shell: true,
        cwd: request.cwd,
        env: { ...request.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: grouped,
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const chunks: string[] = [];
      const ended = (): void => {
        void kill(child);
      };
      if (grouped) {
        for (const signal of ENDING_SIGNALS) {
          signals.once(signal, ended);
        }
      }
      try {
        const { idleFrom } = request;
        const started = idleFrom === undefined ? undefined : (): boolean => chunks.join('').includes(idleFrom);
        const end = await watchSilence(child, request.idleMs, kill, (_stream, chunk) => chunks.push(String(chunk)), cpu, started);
        return { end: end.kind === 'idle' ? end : endOf(end.code, end.signal), output: chunks.join('') };
      } finally {
        if (grouped) {
          for (const signal of ENDING_SIGNALS) {
            signals.off(signal, ended);
          }
        }
      }
    },
  };
}

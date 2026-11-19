import { spawn } from 'node:child_process';
import type { Env } from '../core/home.ts';
import { endOf, type ShellEnd } from '../core/shell-end.ts';
import { posixQuote } from '../open/quote.ts';

export interface ShellRequest {
  /** One command line, read by the platform's shell: `sh` on POSIX, `cmd.exe` on Windows. */
  readonly command: string;
  readonly cwd: string;
  readonly env: Env;
}

export interface ShellResult {
  readonly end: ShellEnd;
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

/** The real shell: Node's `spawn` with `shell: true`, stdin closed, stdout and stderr read as they come. */
export function nodeShellRunner(): ShellRunner {
  return {
    run: (request) =>
      new Promise((resolve, reject) => {
        const child = spawn(request.command, {
          shell: true,
          cwd: request.cwd,
          env: { ...request.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const chunks: string[] = [];
        const keep = (chunk: string): void => {
          chunks.push(chunk);
        };
        child.stdout.setEncoding('utf8').on('data', keep);
        child.stderr.setEncoding('utf8').on('data', keep);
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ end: endOf(code, signal), output: chunks.join('') }));
      }),
  };
}

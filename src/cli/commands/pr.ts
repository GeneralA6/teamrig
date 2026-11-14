import { parseIssueTarget, targetText } from '../../issues/host.ts';
import { printable } from '../../core/printable.ts';
import { pullConflicts } from '../../github/pull-conflicts.ts';
import { onePositional } from '../args.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import type { ParsedArgs } from '../args.ts';

/** A commit id as the report prints it. */
const SHORT_SHA = 7;

/**
 * `pr conflicts <owner/name#n> [--base <branch>]` (T2693): in a clone of the pull request's repository, fetches the
 * pull request's head and prints the files it conflicts on against the newest base (default origin's default
 * branch), for the comment an outside author needs or the work a team pull request's owner must redo. It changes no local
 * branch or file of the clone and writes nothing to GitHub. Exit 0 with a CONFLICTS or CLEAN line, 1 when git
 * failed.
 */
export async function prConflicts(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const text = onePositional(args, 'pull request');
  const target = parseIssueTarget(text);
  if (target === undefined) {
    throw new RefusedError(`${text} names no pull request: give it as owner/name#number, such as acme/web#7`);
  }
  const say = (line: string): void => runtime.out.stdout(line);
  const found = pullConflicts(runtime.pulls, runtime.cwd, target, args.flags.get('base'));
  const name = targetText(target);
  switch (found.kind) {
    case 'failed':
      runtime.out.stderr(`FAILED ${name}: ${found.reason}`);
      return EXIT.failed;
    case 'clean':
      say(`CLEAN ${name} (head ${found.headSha.slice(0, SHORT_SHA)}) merges into ${found.base} (${found.baseSha.slice(0, SHORT_SHA)}) with no conflict`);
      return EXIT.ok;
    case 'conflicts': {
      const count = found.files.length === 1 ? '1 file' : `${found.files.length} files`;
      say(`CONFLICTS ${name} (head ${found.headSha.slice(0, SHORT_SHA)}) against ${found.base} (${found.baseSha.slice(0, SHORT_SHA)}): ${count}`);
      // The file names are the pull request author's: escaped, a newline or ESC in one cannot forge a line or reach the terminal.
      for (const file of found.files) {
        say(`  ${printable(file)}`);
      }
      say(`To land it: rebase its branch onto ${found.base} and resolve these files.`);
      return EXIT.ok;
    }
  }
}

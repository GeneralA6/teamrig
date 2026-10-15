import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { createGit } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { DEFAULT_BASE, localChecks } from './local-checks.ts';
import { machineDeps, parsePushUpdates, proveHead, provePush } from './local-gate.ts';

/**
 * The local gate (see local-gate.ts): proves the checked-out tree with every check CI runs, once per tree.
 * `--pre-push` is the pre-push hook: it reads the pushed commits from stdin and proves each one.
 * Nothing skips it: a push with `--no-verify` is not allowed.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: DEFAULT_BASE },
      'pre-push': { type: 'boolean', default: false },
    },
    strict: true,
    // git passes the pre-push hook the remote's name and URL, which it does not need.
    allowPositionals: true,
  });
  const root = (await createGit(process.cwd()).text(['rev-parse', '--show-toplevel'])).trim();
  const deps = machineDeps(root, process.env, (line) => console.log(line));
  const checks = localChecks(values.base);
  const verdict = values['pre-push'] ? await provePush(parsePushUpdates(readFileSync(0, 'utf8')), checks, deps) : await proveHead(checks, deps);
  if (verdict.passed) return EXIT_CLEAN;
  console.log(`local checks: REFUSED ${verdict.reason}`);
  return EXIT_FINDINGS;
}

process.exitCode = await runMain('local', main, (line) => console.error(line));

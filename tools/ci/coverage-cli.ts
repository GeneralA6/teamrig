import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_USAGE } from '../lib/exit.ts';
import { readTextIfPresent } from '../lib/files.ts';
import { createGit } from '../lib/git.ts';
import { takeRoot } from '../lib/repo-root.ts';
import { runMain } from '../lib/run-main.ts';
import { coverageFindings, coverageRun, coverageTotals, parsePolicy, POLICY_FILE, SOURCE_DIRS, suiteArgs, suiteEnv } from './coverage.ts';
import { hangFinding, runSuite } from './suite-run.ts';

/**
 * Runs the whole test suite of this repo (or `--root <repo>`) once with coverage, then fails on a failing, skipped or
 * todo test, a source file no test loads, or a file or total below the floors in tools/ci/coverage.json.
 * A suite that prints nothing for the policy's suiteIdleSeconds is stopped with its tree and fails as hung.
 */
async function main(args: readonly string[]): Promise<number> {
  const { root: given, rest } = takeRoot(args);
  if (rest.length > 0) throw new Error(`unknown option ${rest.join(' ')} (usage: coverage-cli.ts [--root <repo>])`);
  const root = realpathSync(given);
  const parsed = parsePolicy(JSON.parse(readFileSync(join(root, POLICY_FILE), 'utf8')));
  if (parsed.kind === 'invalid') {
    console.log(`coverage: ${POLICY_FILE}: ${parsed.problem}`);
    return EXIT_USAGE;
  }
  const { policy } = parsed;
  // Untracked files count too, so a new file fails here before it is committed.
  const listed = await createGit(root).text(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_DIRS]);
  const listing = listed.split('\0').filter((path) => path !== '' && existsSync(join(root, path)));
  const out = mkdtempSync(join(tmpdir(), 'teamrig-coverage-'));
  try {
    const lcovPath = join(out, 'lcov.info');
    const tapPath = join(out, 'tap.txt');
    const idleMs = policy.suiteIdleSeconds * 1000;
    const end = await runSuite({ program: process.execPath, args: suiteArgs(policy, lcovPath, tapPath), cwd: root, env: suiteEnv(process.env), idleMs });
    if (end.kind === 'idle') {
      console.log(`coverage: ${hangFinding(end.silentMs, process.versions.node)}`);
      return EXIT_FINDINGS;
    }
    const run = coverageRun(
      { lcov: readTextIfPresent(lcovPath), tap: readTextIfPresent(tapPath), status: end.status },
      listing,
      // The suite ran in root, so its lcov paths resolve from there, not from this run's cwd.
      (path) => relative(root, resolve(root, path)).split(sep).join('/'),
    );
    const findings = coverageFindings(run, policy);
    if (findings.length === 0) {
      console.log(`coverage: ${coverageTotals(run, policy)}`);
      return EXIT_CLEAN;
    }
    console.log(`coverage: ${findings.length} finding(s); every change ships tests (see CONTRIBUTING.md):`);
    findings.forEach((finding) => console.log(`  ${finding}`));
    return EXIT_FINDINGS;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

process.exitCode = await runMain('coverage', () => main(process.argv.slice(2)), (line) => console.error(line));

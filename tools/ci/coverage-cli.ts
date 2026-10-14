import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_USAGE } from '../lib/exit.ts';
import { readTextIfPresent } from '../lib/files.ts';
import { createGit } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { coverageFindings, coverageRun, coverageTotals, parsePolicy, POLICY_FILE, SOURCE_DIRS, suiteArgs, suiteEnv } from './coverage.ts';

/**
 * Runs the whole test suite once with coverage, then fails on a failing, skipped or todo test,
 * a source file no test loads, or a file or total below the floors in tools/ci/coverage.json.
 */
async function main(): Promise<number> {
  const root = realpathSync(process.cwd());
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
    const result = spawnSync(process.execPath, suiteArgs(policy, lcovPath, tapPath), { cwd: root, env: suiteEnv(process.env), stdio: 'inherit' });
    const run = coverageRun(
      { lcov: readTextIfPresent(lcovPath), tap: readTextIfPresent(tapPath), status: result.status },
      listing,
      (absolute) => relative(root, absolute).split(sep).join('/'),
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

process.exitCode = await runMain('coverage', main, (line) => console.error(line));

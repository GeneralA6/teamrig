import { gitSyncIn } from '../lib/git.ts';
import { runMain } from '../lib/run-main.ts';
import { readProfiles } from '../ship/repos.ts';
import { mergeRelease, releaseGate } from './release-merge.ts';
import { gateCommand, mergeCommand } from './release-merge-commands.ts';

/**
 * Run by .github/workflows/release-merge.yml in a checkout of main (T4712): `gate` or `merge`
 * (release-merge-commands.ts), wired to this process's environment, git in its folder, GitHub and its output.
 * A missing or malformed value exits 2.
 */

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length > 0) throw new Error('takes one argument: gate or merge');
  if (command === 'gate') {
    return gateCommand(process.env, { git: gitSyncIn(process.cwd()), profiles: readProfiles(), gate: releaseGate, fetchFn: fetch, out: (text) => process.stdout.write(text) });
  }
  if (command === 'merge') {
    return mergeCommand(process.env, {
      merge: mergeRelease,
      fetchFn: fetch,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  }
  throw new Error('takes one argument: gate or merge');
}

process.exitCode = await runMain('release-merge', main, (line) => console.error(line));

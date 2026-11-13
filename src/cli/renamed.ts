import type { Renamed } from './args.ts';

/**
 * Renamed flags and commands, refused everywhere with the new name, never an alias: `--tier` became `--priority`
 * (levels p1, p2, ...), and for plain words (T1308) `teamrig integrate` became `teamrig merge`, `teamrig roll` became
 * `teamrig deploy`, `teamrig deploys` became `teamrig deploy-status`, `teamrig heavy` became `teamrig queue`, `teamrig
 * claim` became `teamrig freeze`, `teamrig release` became `teamrig unfreeze`, `teamrig windows` became `teamrig
 * stable-periods` and `teamrig load` became `teamrig job` (`load end` with it). `teamrig gh sync` and `teamrig gh
 * migrate` became `teamrig issue sync` and `teamrig issue migrate`, beside `issue comment` and `issue close`, since
 * they are the issue host's commands, not the gh CLI's.
 *
 * The ship gate reads this file's text at main and at the branch tip (tools/ship/renamed-callers.ts), to refuse a
 * merge that renames a command while a consumer still calls the old name: keep `commands: {` on its own line with one
 * `old: 'new',` per line.
 */
export const RENAMED: Renamed = {
  flags: { tier: 'priority', problem: 'type bug [--critical] (or --type task)' },
  commands: {
    integrate: 'merge',
    roll: 'deploy',
    deploys: 'deploy-status',
    heavy: 'queue',
    claim: 'freeze',
    release: 'unfreeze',
    windows: 'stable-periods',
    load: 'job',
    gh: 'issue',
  },
};

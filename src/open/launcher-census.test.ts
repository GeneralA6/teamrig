import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { launcherCensus, launchOf } from './launcher-census.ts';
import type { ListedProcess } from './session-processes.ts';

const WINDOWS_LAUNCH = '"C:\\node\\node.exe" C:\\kit\\dist\\cli\\main.js launch alpha --team app --project "C:\\w\\my app" --no-prompt';

function entry(pid: number, parentPid: number, name: string, commandLine: string, startedMs?: number): ListedProcess {
  const info = { pid, parentPid, name, commandLine };
  return startedMs === undefined ? { info } : { info, startedMs };
}

describe('launchOf', () => {
  it('reads the session and team of a launch command line, quoted or not', () => {
    assert.deepEqual(launchOf('node.exe', WINDOWS_LAUNCH), { session: 'alpha', team: 'app' });
    assert.deepEqual(launchOf('node', '/usr/bin/node "/opt/teamrig/dist/cli/main.js" launch api --team shop'), { session: 'api', team: 'shop' });
    assert.deepEqual(launchOf('node', '/usr/bin/node /opt/main.js launch api'), { session: 'api', team: undefined });
  });

  it('reads no launch from another program or another teamrig command', () => {
    assert.equal(launchOf('claude.exe', WINDOWS_LAUNCH), undefined);
    assert.equal(launchOf('node.exe', 'node C:\\kit\\main.js queue --detached-run 1'), undefined);
    assert.equal(launchOf('node.exe', 'node C:\\kit\\main.js launch --team app'), undefined, 'a flag is no session');
    assert.equal(launchOf('node.exe', 'node C:\\kit\\main.js launch'), undefined);
    assert.equal(launchOf('node.exe', 'node other.js launch alpha'), undefined);
  });
});

describe('launcherCensus', () => {
  const terminal = entry(10, 1, 'WindowsTerminal.exe', 'wt', 100);
  const live = entry(20, 10, 'node.exe', WINDOWS_LAUNCH, 200);

  it('lists each launcher with its starter, and none of another program', () => {
    const census = launcherCensus([terminal, live, entry(21, 20, 'claude.exe', 'claude', 210)]);
    assert.deepEqual(census, {
      launchers: [{ pid: 20, session: 'alpha', team: 'app', startedMs: 200, parentPid: 10, parentName: 'WindowsTerminal.exe', commandLine: WINDOWS_LAUNCH, orphaned: undefined }],
      orphaned: 0,
    });
  });

  it('orphans a launcher whose starter is gone, or whose starter id a later process holds', () => {
    const gone = entry(30, 11, 'node.exe', 'node C:\\kit\\main.js launch beta --team app', 300);
    const reusedStarter = entry(12, 1, 'svchost.exe', 'svchost', 900);
    const reused = entry(40, 12, 'node.exe', 'node C:\\kit\\main.js launch gamma --team app', 400);
    const census = launcherCensus([terminal, live, gone, reusedStarter, reused]);
    assert.deepEqual(
      census.launchers.map((launcher) => [launcher.session, launcher.orphaned, launcher.parentName]),
      [['alpha', undefined, 'WindowsTerminal.exe'], ['beta', 'starter-gone', undefined], ['gamma', 'starter-reused', 'svchost.exe']],
    );
    assert.equal(census.orphaned, 2);
  });

  it('never takes an unknown start for a reused id', () => {
    const census = launcherCensus([entry(10, 1, 'bash', 'bash'), entry(20, 10, 'node', '/usr/bin/node /opt/main.js launch api')]);
    assert.equal(census.launchers[0]?.orphaned, undefined);
  });

  it('never orphans a launcher the caller keeps, its own', () => {
    const census = launcherCensus([entry(30, 11, 'node.exe', 'node C:\\kit\\main.js launch beta', 300)], new Set([30]));
    assert.deepEqual([census.launchers[0]?.orphaned, census.orphaned], [undefined, 0]);
  });
});

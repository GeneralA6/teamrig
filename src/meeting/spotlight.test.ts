import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { MEETING_LAPSE_MS, type Meeting } from './state.ts';
import { SPOTLIGHT_VARS, WINDOWS_SPOTLIGHT_SCRIPT, spotlightLine, spotlightRequest, startSpotlight, type SpotlightTarget } from './spotlight.ts';

const MEETING: Meeting = { startedAt: '2030-01-08T10:00:00.000Z', by: 'lead', endedAt: null, since: null };
const TARGET: Omit<SpotlightTarget, 'dim'> = { title: 'app-lead', meetingFile: 'state/meeting.json', meeting: MEETING, log: 'state/logs/meeting-spotlight.log' };
const ON = { enabled: true, dim: 0.6 };

/** Windows' limit on a whole command line, in characters. */
const COMMAND_LINE_LIMIT = 32_767;

function depsOn(platform: NodeJS.Platform, processes = new FakeProcesses()): { processes: FakeProcesses; env: Record<string, string>; platform: NodeJS.Platform } {
  return { processes, env: { PATH: 'bin' }, platform };
}

describe('spotlightRequest', () => {
  it("passes the title, the meeting file, its start, its lapse and the dim as variables beside the caller's", () => {
    const request = spotlightRequest({ ...TARGET, dim: 0.4 }, { PATH: 'bin' }, 'work');
    assert.equal(request.command, 'powershell.exe');
    assert.equal(request.cwd, 'work');
    assert.equal(request.log, TARGET.log);
    assert.equal(request.needsConsole, true, 'Windows PowerShell runs nothing without a console');
    assert.deepEqual(request.env, {
      PATH: 'bin',
      [SPOTLIGHT_VARS.title]: 'app-lead',
      [SPOTLIGHT_VARS.meeting]: 'state/meeting.json',
      [SPOTLIGHT_VARS.startedAt]: MEETING.startedAt,
      [SPOTLIGHT_VARS.until]: String(Date.parse(MEETING.startedAt) + MEETING_LAPSE_MS),
      [SPOTLIGHT_VARS.dim]: '0.4',
    });
  });

  it('runs one fixed script, which holds none of the values, encoded within the command line limit', () => {
    const request = spotlightRequest({ ...TARGET, title: 'a title "quoted" $(here)', dim: 0.6 }, {}, 'work');
    const encoded = request.args.at(-1) ?? '';
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), WINDOWS_SPOTLIGHT_SCRIPT);
    assert.ok(!WINDOWS_SPOTLIGHT_SCRIPT.includes('quoted'));
    assert.ok(!WINDOWS_SPOTLIGHT_SCRIPT.includes('meeting.json'));
    assert.ok([request.command, ...request.args].join(' ').length < COMMAND_LINE_LIMIT);
  });

  it('reads every variable it is given, and exits on the meeting end, another meeting, a lapse or unreadable reads', () => {
    Object.values(SPOTLIGHT_VARS).forEach((name) => assert.ok(WINDOWS_SPOTLIGHT_SCRIPT.includes(`$env:${name}`), name));
    assert.match(WINDOWS_SPOTLIGHT_SCRIPT, /\$meeting\.startedAt -ceq \$startedAt\) -and \(\$null -eq \$meeting\.endedAt\)/);
    assert.match(WINDOWS_SPOTLIGHT_SCRIPT, /ToUnixTimeMilliseconds\(\) -ge \$until\) \{ return \$false \}/);
    assert.match(WINDOWS_SPOTLIGHT_SCRIPT, /if \(\$unreadable -ge 3\) \{ exit 0 \}/);
  });
});

describe('startSpotlight', () => {
  it('starts nothing while the team keeps it off', async () => {
    const deps = depsOn('win32');
    assert.deepEqual(await startSpotlight(deps, { enabled: false, dim: 0.6 }, 'auto', TARGET, 'work'), { kind: 'off' });
    assert.deepEqual(deps.processes.hidden, []);
  });

  it('starts nothing off Windows, and says why', async () => {
    const deps = depsOn('linux');
    assert.deepEqual(await startSpotlight(deps, ON, 'auto', TARGET, 'work'), { kind: 'unsupported', why: 'it needs Windows, and this is linux' });
    assert.deepEqual(deps.processes.hidden, []);
  });

  for (const terminal of ['print', 'tmux'] as const) {
    it(`starts nothing when open.terminal ${terminal} leaves Windows Terminal out`, async () => {
      const deps = depsOn('win32');
      assert.deepEqual(await startSpotlight(deps, ON, terminal, TARGET, 'work'), { kind: 'unsupported', why: `it needs Windows Terminal, and open.terminal is ${terminal}` });
      assert.deepEqual(deps.processes.hidden, []);
    });
  }

  for (const terminal of ['auto', 'windows-terminal'] as const) {
    it(`starts the hidden overlay at the team's dim with open.terminal ${terminal}`, async () => {
      const deps = depsOn('win32');
      assert.deepEqual(await startSpotlight(deps, { enabled: true, dim: 0.3 }, terminal, TARGET, 'work'), { kind: 'start', outcome: { kind: 'started', end: 'spawned' } });
      assert.equal(deps.processes.hidden.length, 1);
      assert.equal(deps.processes.hidden[0]?.env?.[SPOTLIGHT_VARS.dim], '0.3');
    });
  }
});

describe('spotlightLine', () => {
  it('prints nothing when off, and each other outcome in one line', () => {
    assert.equal(spotlightLine({ kind: 'off' }, TARGET, 0.6), undefined);
    assert.equal(spotlightLine({ kind: 'unsupported', why: 'it needs Windows, and this is linux' }, TARGET, 0.6), 'NOT SPOTLIT: it needs Windows, and this is linux');
    assert.equal(
      spotlightLine({ kind: 'start', outcome: { kind: 'started', end: 'spawned' } }, TARGET, 0.6),
      'SPOTLIGHT every screen dimmed (0.6) but the window of app-lead, until the meeting ends; its errors go to state/logs/meeting-spotlight.log',
    );
    assert.equal(spotlightLine({ kind: 'start', outcome: { kind: 'missing' } }, TARGET, 0.6), 'NOT SPOTLIT: Windows PowerShell is not installed');
    assert.equal(spotlightLine({ kind: 'start', outcome: { kind: 'failed', error: 'EACCES' } }, TARGET, 0.6), 'NOT SPOTLIT: EACCES');
  });
});

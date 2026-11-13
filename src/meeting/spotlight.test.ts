import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { SPOTLIGHT_VARS, WINDOWS_SPOTLIGHT_SCRIPT, spotlightLine, spotlightRequest, startSpotlight, type SpotlightPlace } from './spotlight.ts';

const STARTED_AT = '2030-01-08T10:00:00.000Z';
const UNTIL = Date.parse('2030-01-08T10:45:00.000Z');
const TARGET: SpotlightPlace = {
  title: 'app-lead',
  meetingFile: 'state/meeting.json',
  startedAt: STARTED_AT,
  until: UNTIL,
  breakthroughFile: 'state/meeting-breakthrough.json',
  log: 'state/logs/meeting-spotlight.log',
};
const ON = { enabled: true, dim: 0.6, breakthroughSeconds: 120 };

/** Windows' limit on a whole command line, in characters. */
const COMMAND_LINE_LIMIT = 32_767;

function depsOn(platform: NodeJS.Platform, processes = new FakeProcesses()): { processes: FakeProcesses; env: Record<string, string>; platform: NodeJS.Platform } {
  return { processes, env: { PATH: 'bin' }, platform };
}

describe('spotlightRequest', () => {
  it("passes the title, the meeting file, its start, its lapse, the dim, the break-through file and its lift as variables beside the caller's", () => {
    const request = spotlightRequest({ ...TARGET, dim: 0.4, liftMs: 30_000 }, { PATH: 'bin' }, 'work');
    assert.equal(request.command, 'powershell.exe');
    assert.equal(request.cwd, 'work');
    assert.equal(request.log, TARGET.log);
    assert.equal(request.needsConsole, true, 'Windows PowerShell runs nothing without a console');
    assert.deepEqual(request.env, {
      PATH: 'bin',
      [SPOTLIGHT_VARS.title]: 'app-lead',
      [SPOTLIGHT_VARS.meeting]: 'state/meeting.json',
      [SPOTLIGHT_VARS.startedAt]: STARTED_AT,
      [SPOTLIGHT_VARS.until]: String(UNTIL),
      [SPOTLIGHT_VARS.dim]: '0.4',
      [SPOTLIGHT_VARS.breakthrough]: 'state/meeting-breakthrough.json',
      [SPOTLIGHT_VARS.liftMs]: '30000',
    });
  });

  it('runs one fixed script, which holds none of the values, encoded within the command line limit', () => {
    const request = spotlightRequest({ ...TARGET, title: 'a title "quoted" $(here)', dim: 0.6, liftMs: 120_000 }, {}, 'work');
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

  it("hides the dimming for liftMs after a break-through of its own meeting, checked with the meeting file (T2524)", () => {
    assert.match(WINDOWS_SPOTLIGHT_SCRIPT, /\$at = \[long\]\$breakthrough\.atMs \} catch \{ return \$false \}/);
    assert.match(WINDOWS_SPOTLIGHT_SCRIPT, /\(\$breakthrough\.startedAt -ceq \$startedAt\) -and \(\[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\) -lt \$at \+ \$liftMs\)/);
    const check = WINDOWS_SPOTLIGHT_SCRIPT.indexOf('$open = Test-MeetingOpen');
    assert.ok(check >= 0 && WINDOWS_SPOTLIGHT_SCRIPT.indexOf('$lifted = Test-Lifted') > check, 'read at each 2 s check');
    assert.match(WINDOWS_SPOTLIGHT_SCRIPT, /if \(\$hole\.IsEmpty -or \$lifted\) \{\n\s*if \(\$overlay\.Visible\) \{ \$overlay\.Hide\(\) \}/);
  });
});

describe('startSpotlight', () => {
  it('starts nothing while the team keeps it off', async () => {
    const deps = depsOn('win32');
    assert.deepEqual(await startSpotlight(deps, { ...ON, enabled: false }, 'auto', TARGET, 'work'), { kind: 'off' });
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
      assert.deepEqual(await startSpotlight(deps, { ...ON, dim: 0.3 }, terminal, TARGET, 'work'), { kind: 'start', outcome: { kind: 'started', end: 'spawned' } });
      assert.equal(deps.processes.hidden.length, 1);
      assert.equal(deps.processes.hidden[0]?.env?.[SPOTLIGHT_VARS.dim], '0.3');
      assert.equal(deps.processes.hidden[0]?.env?.[SPOTLIGHT_VARS.liftMs], '120000', "the team's breakthroughSeconds in ms");
    });
  }
});

describe('spotlightLine', () => {
  it('prints nothing when off or where it cannot run, and each start outcome in one line (T2523)', () => {
    assert.equal(spotlightLine({ kind: 'off' }, TARGET, 0.6), undefined);
    assert.equal(spotlightLine({ kind: 'unsupported', why: 'it needs Windows, and this is linux' }, TARGET, 0.6), undefined);
    assert.equal(
      spotlightLine({ kind: 'start', outcome: { kind: 'started', end: 'spawned' } }, TARGET, 0.6),
      'SPOTLIGHT every screen dimmed (0.6) but the window of app-lead, until the meeting ends; its errors go to state/logs/meeting-spotlight.log',
    );
    assert.equal(spotlightLine({ kind: 'start', outcome: { kind: 'missing' } }, TARGET, 0.6), 'NOT SPOTLIT: Windows PowerShell is not installed');
    assert.equal(spotlightLine({ kind: 'start', outcome: { kind: 'failed', error: 'EACCES' } }, TARGET, 0.6), 'NOT SPOTLIT: EACCES');
  });
});

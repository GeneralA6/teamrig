import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { APP, CliHarness, KIT, TEAM } from '../../testing/cli-harness.ts';
import { FakePathProbe, FakeProcesses } from '../../testing/fake-processes.ts';

const ENTRY = resolve('/', 'pane', 'out', 'ui', 'main.js');
const NODE = '/usr/bin/node';
const SCRIPT = '/opt/teamrig/dist/cli/main.js';
const WITH_UI = { ...TEAM, ui: { path: ENTRY } };

function world(): { processes: FakeProcesses; probe: FakePathProbe } {
  return { processes: new FakeProcesses(), probe: new FakePathProbe({ files: [ENTRY] }) };
}

describe('teamrig ui', () => {
  it('runs the entry ui.path names under its own node, for the team here, in the caller’s folder', async () => {
    const { processes, probe } = world();
    const result = await new CliHarness(WITH_UI).run(['ui'], { processes, probe, env: { PATH: '/bin' } });
    assert.deepEqual(result, { code: 0, stdout: [], stderr: [] });
    assert.deepEqual(processes.ran, [
      { command: NODE, args: [ENTRY, '--team', 'app'], cwd: APP, env: { TEAMRIG_HOME: KIT, PATH: '/bin', TEAMRIG_CLI: SCRIPT, TEAMRIG_NODE: NODE } },
    ]);
  });

  it('opens on the session --session names, by its id', async () => {
    const { processes, probe } = world();
    const result = await new CliHarness(WITH_UI).run(['ui', '--session', 'app-alpha'], { processes, probe });
    assert.equal(result.code, 0);
    assert.deepEqual(processes.ran[0]?.args, [ENTRY, '--team', 'app', '--session', 'alpha']);
  });

  it('refuses a session the team lacks and starts nothing', async () => {
    const { processes, probe } = world();
    const result = await new CliHarness(WITH_UI).run(['ui', '--session', 'zulu'], { processes, probe });
    assert.equal(result.code, 2);
    assert.deepEqual(processes.ran, []);
  });

  it('shows the team --team names from a folder of no team', async () => {
    const { processes, probe } = world();
    const cwd = resolve('/', 'elsewhere');
    const result = await new CliHarness(WITH_UI, null).run(['ui', '--team', 'app'], { processes, probe, cwd });
    assert.equal(result.code, 0);
    assert.deepEqual([processes.ran[0]?.args, processes.ran[0]?.cwd], [[ENTRY, '--team', 'app'], cwd]);
  });

  it('refuses a --team that is no team id, or one with no config, and starts nothing', async () => {
    const { processes, probe } = world();
    const kit = new CliHarness(WITH_UI);
    const bad = await kit.run(['ui', '--team', join('..', 'app')], { processes, probe });
    assert.equal(bad.code, 64);
    const none = await kit.run(['ui', '--team', 'other'], { processes, probe });
    assert.equal(none.code, 2);
    assert.match(none.stdout.join('\n'), /^REFUSED no team config/);
    assert.deepEqual(processes.ran, []);
  });

  it('is refused without ui.path, saying no released UI is pinned and naming the key', async () => {
    const { processes, probe } = world();
    const result = await new CliHarness().run(['ui'], { processes, probe });
    assert.equal(result.code, 2);
    assert.match(result.stdout.join('\n'), /^REFUSED no released UI is pinned in this teamrig yet; set ui\.path /);
    assert.deepEqual(processes.ran, []);
  });

  it('is refused when ui.path names no file, a folder included', async () => {
    for (const probe of [new FakePathProbe(), new FakePathProbe({ folders: [ENTRY] })]) {
      const processes = new FakeProcesses();
      const result = await new CliHarness(WITH_UI).run(['ui'], { processes, probe });
      assert.equal(result.code, 2);
      assert.match(result.stdout.join('\n'), /^REFUSED ui\.path names .*main\.js, and no file is there/);
      assert.deepEqual(processes.ran, []);
    }
  });

  it('fails with the UI’s exit code named, and when node is gone or cannot start', async () => {
    const outcomes = [
      [{ kind: 'exited', code: 143 }, 'FAILED the UI exited with code 143'],
      [{ kind: 'missing' }, `FAILED ${NODE} is gone`],
      [{ kind: 'failed', error: 'EACCES' }, `FAILED ${NODE}: EACCES`],
    ] as const;
    for (const [outcome, line] of outcomes) {
      const processes = new FakeProcesses().onRun(NODE, outcome);
      const result = await new CliHarness(WITH_UI).run(['ui'], { processes, probe: new FakePathProbe({ files: [ENTRY] }) });
      assert.deepEqual([result.code, result.stderr], [1, [line]]);
    }
  });

  it('takes no positional word', async () => {
    const { processes, probe } = world();
    const result = await new CliHarness(WITH_UI).run(['ui', 'alpha'], { processes, probe });
    assert.equal(result.code, 64);
    assert.deepEqual(processes.ran, []);
  });
});

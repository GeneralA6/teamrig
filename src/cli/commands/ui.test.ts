import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { APP, CliHarness, KIT, TEAM } from '../../testing/cli-harness.ts';
import { FakeHttp } from '../../testing/fake-http.ts';
import { FakePathProbe, FakeProcesses } from '../../testing/fake-processes.ts';
import { normalisePath } from '../../testing/memory-files.ts';
import { ARCHIVE_FORMAT, sha256Hex } from '../../ui/archive.ts';
import type { UiPin } from '../../ui/released.ts';
import type { ParsedArgs } from '../args.ts';
import { RefusedError } from '../runtime.ts';
import { uiCommand } from './ui.ts';

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

  describe('the released UI, without ui.path', () => {
    const VERSION = '0.77.0';
    const URL = 'https://releases.example/pane/teamrig-ui.json';
    const ARCHIVE = `${JSON.stringify({
      format: ARCHIVE_FORMAT,
      version: VERSION,
      entry: 'ui/main.js',
      files: [
        { path: 'package.json', text: '{"type":"module"}\n' },
        { path: 'ui/main.js', text: 'export {};\n' },
      ],
    })}\n`;
    const PIN: UiPin = { version: VERSION, url: URL, sha256: sha256Hex(new TextEncoder().encode(ARCHIVE)) };
    const RELEASED_ENTRY = `${normalisePath(KIT)}/ui/${VERSION}-${PIN.sha256}/ui/main.js`;
    const CALLER_ENV = { PATH: '/bin', LANG: 'C.UTF-8', GH_TOKEN: 'token', NODE_OPTIONS: '--require /x.js' };

    function argsOf(flags: Readonly<Record<string, string>> = {}): ParsedArgs {
      return { command: 'ui', positionals: [], flags: new Map(Object.entries(flags)), switches: new Set(), rest: [], help: false, common: new Map() };
    }

    it('fetches and installs the pinned UI once, then runs it with only the allowed variables', async () => {
      const kit = new CliHarness();
      const http = new FakeHttp().answers('GET', URL, 200, ARCHIVE);
      const processes = new FakeProcesses();
      const start = uiCommand(PIN);
      assert.equal(await start(argsOf(), kit.runtime({ processes, http, env: CALLER_ENV })), 0);
      assert.equal(await start(argsOf(), kit.runtime({ processes, http, env: CALLER_ENV })), 0);
      assert.equal(http.requests.length, 1);
      assert.deepEqual(
        processes.ran.map((ran) => [ran.command, normalisePath(ran.args[0] ?? ''), ran.args.slice(1), ran.env]),
        [0, 1].map(() => [NODE, RELEASED_ENTRY, ['--team', 'app'], { TEAMRIG_HOME: KIT, PATH: '/bin', LANG: 'C.UTF-8', TEAMRIG_CLI: SCRIPT, TEAMRIG_NODE: NODE }]),
      );
    });

    it('runs ui.path, with the whole environment, over the pin, and fetches nothing', async () => {
      const http = new FakeHttp();
      const { processes, probe } = world();
      assert.equal(await uiCommand(PIN)(argsOf(), new CliHarness(WITH_UI).runtime({ processes, probe, http, env: CALLER_ENV })), 0);
      assert.deepEqual(http.requests, []);
      assert.deepEqual(processes.ran[0]?.args[0], ENTRY);
      assert.deepEqual(processes.ran[0]?.env, { TEAMRIG_HOME: KIT, ...CALLER_ENV, TEAMRIG_CLI: SCRIPT, TEAMRIG_NODE: NODE });
    });

    it('is refused, starting nothing, when the fetched archive misses the pin or cannot be fetched', async () => {
      for (const [http, reason] of [
        [new FakeHttp().answers('GET', URL, 200, `${ARCHIVE} `), /^the fetched UI 0\.77\.0 was refused: /],
        [new FakeHttp().answers('GET', URL, 404), /^the UI 0\.77\.0 could not be fetched: the server answered 404$/],
      ] as const) {
        const processes = new FakeProcesses();
        await assert.rejects(uiCommand(PIN)(argsOf(), new CliHarness().runtime({ processes, http })), (error: unknown) => error instanceof RefusedError && reason.test(error.message));
        assert.deepEqual(processes.ran, []);
      }
    });
  });

  it('takes no positional word', async () => {
    const { processes, probe } = world();
    const result = await new CliHarness(WITH_UI).run(['ui', 'alpha'], { processes, probe });
    assert.equal(result.code, 64);
    assert.deepEqual(processes.ran, []);
  });
});

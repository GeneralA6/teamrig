import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { APP, bash, CliHarness, CONFIG_PATH, decisionOf, KIT, TEAM, USER_HOME } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const ON_TEAM: JsonRecord = { ...TEAM, readonlyShell: { enabled: true, allowPrefixes: ['npx jest'] } };
const HOOK = ['hook', 'readonly-allow'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };

function powershell(command: string): string {
  return JSON.stringify({ tool_name: 'PowerShell', tool_input: { command }, cwd: APP });
}

describe('hook readonly-allow', () => {
  it('allows a Bash or PowerShell line that only reads, and a trusted prefix, with the hook on', async () => {
    const kit = new CliHarness(ON_TEAM);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: bash('grep -rn x src | head -5') })), 'allow');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: powershell('Get-Content f -Raw | ConvertFrom-Json') })), 'allow');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: bash('npx jest src/a.spec.ts 2>&1 | tail -5') })), 'allow');
  });

  it('prints nothing for a line that writes or runs, so the permission check decides', async () => {
    const kit = new CliHarness(ON_TEAM);
    for (const command of ['grep x f > out.txt', 'rm -rf /tmp/x', 'git push origin main', 'npx tsc --noEmit']) {
      assert.deepEqual(await kit.run(HOOK, { stdin: bash(command) }), NOTHING, command);
    }
  });

  it('prints nothing on Windows for a line whose halved text, the one bash receives there, runs a hidden command', async () => {
    const kit = new CliHarness(ON_TEAM);
    const hidden = bash(`ls a${'\\'.repeat(3)}; rm -f x`);
    assert.deepEqual(await kit.run(HOOK, { stdin: hidden, platform: 'win32' }), NOTHING);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: hidden, platform: 'linux' })), 'allow');
  });

  it("refuses to let the line set a name Claude Code's environment exports", async () => {
    const kit = new CliHarness(ON_TEAM);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: bash('npm_config_prefix=/tmp/x') })), 'allow');
    assert.deepEqual(await kit.run(HOOK, { stdin: bash('npm_config_prefix=/tmp/x'), env: { npm_config_prefix: '/u/npm' } }), NOTHING);
  });

  it("refuses a name the newest shell snapshot exports, and every name under its set -a", async () => {
    const kit = new CliHarness(ON_TEAM);
    const snapshots = join(USER_HOME, '.claude', 'shell-snapshots');
    await kit.files.write(join(snapshots, 'snapshot-bash-1-a.sh'), 'set -a');
    await kit.files.write(join(snapshots, 'snapshot-bash-2-b.sh'), "export pod='x'");
    assert.deepEqual(await kit.run(HOOK, { stdin: bash('pod=y; cat f') }), NOTHING);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: bash('out=y; cat f') })), 'allow');
    await kit.files.write(join(snapshots, 'snapshot-bash-3-c.sh'), 'set -a');
    assert.deepEqual(await kit.run(HOOK, { stdin: bash('out=y; cat f') }), NOTHING);
  });

  it('prints nothing with the hook off, by default, or with the config missing, broken or unreadable', async () => {
    const off = [new CliHarness(), new CliHarness({ ...TEAM, readonlyShell: { enabled: false } }), new CliHarness(null), new CliHarness('{ not json')];
    for (const kit of off) {
      assert.deepEqual(await kit.run(HOOK, { stdin: bash('cat f') }), NOTHING);
    }
    const locked = new CliHarness(ON_TEAM);
    const files = new FaultyFiles(locked.files).fail('read', CONFIG_PATH, systemError('EACCES'));
    assert.deepEqual(await locked.run(HOOK, { stdin: bash('cat f'), files }), NOTHING);
  });

  it("reads the session's team, not the team of a folder the line moved into", async () => {
    const kit = new CliHarness();
    const web = resolve('/', 'work', 'web');
    await kit.files.write(join(web, '.teamrig.json'), '{"team": "web"}');
    await kit.files.write(join(KIT, 'teams', 'web', 'config.json'), JSON.stringify(ON_TEAM));
    const moved = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat f' }, cwd: web });
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: moved, cwd: web })), 'allow');
    assert.deepEqual(await kit.run(HOOK, { stdin: moved, env: { CLAUDE_PROJECT_DIR: APP } }), NOTHING);
  });

  it("prints nothing outside a team's projects or for input that is not a hook payload", async () => {
    assert.deepEqual(await new CliHarness(ON_TEAM, null).run(HOOK, { stdin: bash('cat f') }), NOTHING);
    assert.deepEqual(await new CliHarness(ON_TEAM).run(HOOK, { stdin: 'not json' }), NOTHING);
  });
});

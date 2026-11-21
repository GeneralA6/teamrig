import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { settingsWriteRefusal } from '../core/settings-writers.ts';
import { bash, CliHarness, decisionOf, reasonOf, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { hostNaming } from '../testing/host.ts';
import { sessionVariablesOf } from './host.ts';

/** A tab bound to alpha, as its session variable says. */
const ALPHA = { TEAMRIG_SESSION: 'alpha' };
/** A host that is not shipped, telling its sessions by variables of its own. */
const OTHER_HOST = hostNaming({ marks: ['OTHER_AGENT'], identity: ['OTHER_SESSION'] });

function guard(kit: CliHarness, command: string, options: RunOptions = {}): Promise<CliResult> {
  return kit.run(['hook', 'exec-guard'], { ...options, env: { ...ALPHA, ...options.env }, stdin: bash(command) });
}

describe("hook exec-guard, the variables the hosts tell a session by (T4749)", () => {
  it('holds the two variables it held by name, and the one the shipped host names a session folder with', () => {
    const held = sessionVariablesOf(new CliHarness().runtime());
    assert.deepEqual(
      ['CLAUDECODE'].filter((name) => !held.marks.includes(name)),
      [],
    );
    assert.deepEqual(
      ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR'].filter((name) => !held.identity.includes(name)),
      [],
    );
  });

  it("denies a line that changes each variable of the shipped host's, end to end", async () => {
    const kit = new CliHarness();
    assert.match(reasonOf(await guard(kit, 'env -u CLAUDECODE teamrig list')) ?? '', /^teamrig exec guard: this line changes \$CLAUDECODE, /);
    for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR']) {
      const result = await guard(kit, `${name}=other teamrig start`);
      assert.equal(decisionOf(result), 'deny', name);
      assert.ok(reasonOf(result)?.includes(`runs on a line that changes what the CLI binds the tab by ($${name}); name this tab's own (--session alpha)`), name);
    }
    assert.deepEqual((await guard(kit, 'CLAUDE_PROJECT_DIR=other npm test')).stdout, [], 'no bind on the line');
    assert.deepEqual((await guard(kit, 'teamrig start')).stdout, [], 'no variable changed');
  });

  it("holds every shipped host's variables on a host that is not shipped, beside that host's own", async () => {
    const kit = new CliHarness();
    const other = { host: OTHER_HOST };
    for (const mark of ['CLAUDECODE', 'OTHER_AGENT']) {
      assert.match(reasonOf(await guard(kit, `${mark}= teamrig list`, other)) ?? '', new RegExp(`^teamrig exec guard: this line changes \\$${mark}, `), mark);
    }
    for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'OTHER_SESSION']) {
      assert.ok(reasonOf(await guard(kit, `${name}=other teamrig inbox read`, other))?.includes(`what the CLI binds the tab by ($${name})`), name);
    }
    assert.deepEqual((await guard(kit, 'OTHER_AGENT= teamrig list')).stdout, [], "a name the shipped host does not hold, where it runs");
  });

  it("names the mark of the hook's own run in a settings writer's refusal, and none where no mark is set", async () => {
    const kit = new CliHarness();
    const line = 'teamrig permissions trim --yes';
    assert.equal(reasonOf(await guard(kit, line, { env: { CLAUDECODE: '1' } })), `teamrig exec guard: ${settingsWriteRefusal('permissions trim', 'CLAUDECODE')}`);
    assert.equal(reasonOf(await guard(kit, line, { env: { OTHER_AGENT: '1' }, host: OTHER_HOST })), `teamrig exec guard: ${settingsWriteRefusal('permissions trim', 'OTHER_AGENT')}`);
    assert.equal(reasonOf(await guard(kit, line)), `teamrig exec guard: ${settingsWriteRefusal('permissions trim', undefined)}`);
  });
});

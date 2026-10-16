import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CliHarness, TEAM, USER_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const USER_SETTINGS = join(USER_HOME, '.claude', 'settings.json');
const PROJECT_SETTINGS = join(APP, '.claude', 'settings.json');
const LOCAL_SETTINGS = join(APP, '.claude', 'settings.local.json');

/** Each line's first two words: the header's count, then each finding's kind, in order. */
function kinds(stdout: readonly string[]): string[] {
  return stdout.map((line) => line.split(' ').slice(0, 2).join(' '));
}

describe('teamrig doctor: what overrides a model or effort choice', () => {
  it("reads the routing variables from its environment and the user's and the project's settings, and a launch with no effort", async () => {
    const kit = new CliHarness({ ...TEAM, launch: { alpha: { model: 'sonnet' }, bravo: { model: 'opus', effort: 'high' } } });
    await kit.files.write(USER_SETTINGS, JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', ANTHROPIC_API_KEY: 'secret-value' } }));
    await kit.files.write(PROJECT_SETTINGS, '{ not json');
    await kit.files.write(LOCAL_SETTINGS, JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' } }));
    const result = await kit.run(['doctor'], { env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } });
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(kinds(result.stdout), ['DOCTOR 5', 'WARN effort-env', 'WARN effort-env', 'WARN model-env', 'WARN settings-json', 'WARN launch-effort']);
    const text = result.stdout.join('\n');
    assert.match(text, /CLAUDE_CODE_EFFORT_LEVEL=low is set in the environment doctor runs in: /);
    assert.ok(text.includes(`CLAUDE_CODE_EFFORT_LEVEL=medium is set in the env block of ${LOCAL_SETTINGS}: `));
    assert.ok(text.includes(`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 is set in the env block of ${USER_SETTINGS}: `));
    assert.ok(text.includes(`WARN settings-json ${PROJECT_SETTINGS} is not a JSON object`));
    assert.ok(text.includes('WARN launch-effort app-alpha (session alpha) launches on model sonnet with no effort'));
    assert.doesNotMatch(text, /secret-value|ANTHROPIC_API_KEY/);
  });

  it('stays clean with the variables unset, valid settings and every named model given an effort', async () => {
    const kit = new CliHarness({ ...TEAM, launch: { lead: { model: 'sonnet' }, alpha: { model: 'opus', effort: 'xhigh' } } });
    await kit.files.write(USER_SETTINGS, JSON.stringify({ env: { DISABLE_TELEMETRY: '1' } }));
    assert.deepEqual((await kit.run(['doctor'])).stdout, ['DOCTOR clean, team app']);
  });
});

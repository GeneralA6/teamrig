import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { claudeProjectSlug } from '../budget/discover.ts';
import { APP, CliHarness, TEAM, USER_HOME } from '../testing/cli-harness.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { skillListingLine, transcript, type FixtureListing } from '../testing/transcript-lines.ts';
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
    await kit.files.write(USER_SETTINGS, JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', ANTHROPIC_API_KEY: 'not a real key' } }));
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
    assert.doesNotMatch(text, /not a real key|ANTHROPIC_API_KEY/);
  });

  it('stays clean with the variables unset, valid settings and every named model given an effort', async () => {
    const kit = new CliHarness({ ...TEAM, launch: { lead: { model: 'sonnet' }, alpha: { model: 'opus', effort: 'xhigh' } } });
    await kit.files.write(USER_SETTINGS, JSON.stringify({ env: { DISABLE_TELEMETRY: '1' } }));
    assert.deepEqual((await kit.run(['doctor'])).stdout, ['DOCTOR clean, team app']);
  });
});

describe('teamrig doctor: the lists a session holds in its context', () => {
  const session = join(USER_HOME, '.claude', 'projects', claudeProjectSlug(APP), '0b9c8d2e-1f3a-4b5c-8d6e-7f8091a2b3c4.jsonl');
  const skills = (count: number): FixtureListing[] => Array.from({ length: count }, (_, i) => ({ name: `skill-${i}`, description: 'd'.repeat(990) }));

  it("flags the project's newest session whose lists are over their budget", async () => {
    const transcripts = new MemoryTranscripts({ [session]: transcript([skillListingLine(skills(20))]) });
    const result = await new CliHarness(TEAM).run(['doctor'], { transcripts });
    assert.deepEqual(kinds(result.stdout), ['DOCTOR 1', 'WARN context-lists']);
    assert.ok(result.stdout[1]?.includes(`(${session}): `));
    assert.ok(result.stdout[1]?.includes('[contextFiles.maxSessionListsChars]: skills 20, '));
  });

  it('stays clean with the lists under their budget', async () => {
    const transcripts = new MemoryTranscripts({ [session]: transcript([skillListingLine(skills(2))]) });
    assert.deepEqual((await new CliHarness(TEAM).run(['doctor'], { transcripts })).stdout, ['DOCTOR clean, team app']);
  });
});

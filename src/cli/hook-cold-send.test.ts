import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CLAUDE_SESSION, CliHarness, decisionOf, TEAM, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';

const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const OLD_ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a0';
const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;

function transcriptOf(tab: string): string {
  return join(USER_HOME, '.claude', 'projects', 'work-app', `${tab}.jsonl`);
}

function send(to: string, from = CLAUDE_SESSION): string {
  return JSON.stringify({ session_id: from, cwd: APP, tool_name: 'SendMessage', tool_input: { to, message: 'the ask' } });
}

/** A team where `alpha` read its inbox from ALPHA_TAB, whose transcript last changed `idleMinutes` ago. */
async function teamWithAlphaIdle(idleMinutes: number, config = TEAM): Promise<{ kit: CliHarness; transcripts: MemoryTranscripts }> {
  const kit = new CliHarness(config);
  await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
  const transcripts = new MemoryTranscripts();
  transcripts.set(transcriptOf(ALPHA_TAB), '{}\n', NOW - idleMinutes * MINUTE);
  return { kit, transcripts };
}

function reasonOf(result: CliResult): string {
  const [line] = result.stdout;
  assert.ok(line !== undefined);
  return line;
}

describe('the cold-send hook', () => {
  it('holds a send to a team session idle past the limit once, then lets the same tab send it', async () => {
    const { kit, transcripts } = await teamWithAlphaIdle(125);
    const held = await kit.run(['hook', 'cold-send'], { stdin: send('app-alpha'), transcripts });
    assert.equal(held.code, 0);
    assert.equal(decisionOf(held), 'deny');
    assert.match(reasonOf(held), /Held once: app-alpha has been idle 125 min/);
    assert.ok(reasonOf(held).includes('teamrig inbox add --to alpha --text'));
    const resent = await kit.run(['hook', 'cold-send'], { stdin: send('alpha'), transcripts });
    assert.deepEqual(resent.stdout, []);
  });

  it("takes the newest of the receiver's tabs, so an old tab left by a restart does not count", async () => {
    const kit = new CliHarness(TEAM);
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: OLD_ALPHA_TAB } });
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
    const transcripts = new MemoryTranscripts();
    transcripts.set(transcriptOf(OLD_ALPHA_TAB), '{}\n', NOW - 600 * MINUTE);
    transcripts.set(transcriptOf(ALPHA_TAB), '{}\n', NOW - 5 * MINUTE);
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('alpha'), transcripts })).stdout, []);
  });

  it('lets a send to a session active within the limit go', async () => {
    const { kit, transcripts } = await teamWithAlphaIdle(59);
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('alpha'), transcripts })).stdout, []);
  });

  it('lets a send go to a receiver off the team, to one with no transcript, and from the receiver itself', async () => {
    const { kit, transcripts } = await teamWithAlphaIdle(125);
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('explore-helper'), transcripts })).stdout, []);
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('bravo'), transcripts })).stdout, []);
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('alpha', ALPHA_TAB), transcripts })).stdout, []);
  });

  it('never holds with messages.coldAfterMinutes 0', async () => {
    const { kit, transcripts } = await teamWithAlphaIdle(600, { ...TEAM, messages: { coldAfterMinutes: 0 } });
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: send('alpha'), transcripts })).stdout, []);
  });

  it('prints nothing outside a team or for another tool', async () => {
    const transcripts = new MemoryTranscripts();
    transcripts.set(transcriptOf(ALPHA_TAB), '{}\n', NOW - 600 * MINUTE);
    const noTeam = new CliHarness(TEAM, null);
    assert.deepEqual((await noTeam.run(['hook', 'cold-send'], { stdin: send('alpha'), transcripts })).stdout, []);
    const { kit } = await teamWithAlphaIdle(600);
    const bash = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.deepEqual((await kit.run(['hook', 'cold-send'], { stdin: bash, transcripts })).stdout, []);
  });
});

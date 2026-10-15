import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { APP, CliHarness, decisionOf, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { replyLine, transcript } from '../testing/transcript-lines.ts';
import { EXIT } from './runtime.ts';

/** The harness clock is Tuesday 2030-01-08 10:00 UTC; this week resets on Monday 2030-01-14 01:00 UTC, so the pace line is at 19.7%. */
const RESET = Date.parse('2030-01-14T01:00:00Z');
const PROJECT = join(USER_HOME, '.claude', 'projects', 'app');
const ALPHA_TAB = '0000000a-0000-4000-8000-000000000001';
const LEAD_TAB = '0000000d-0000-4000-8000-000000000004';
const ALPHA_TRANSCRIPT = join(PROJECT, `${ALPHA_TAB}.jsonl`);
const LEAD_TRANSCRIPT = join(PROJECT, `${LEAD_TAB}.jsonl`);

/** 1% of the week is 10M W; alpha's daily budget is 1%. */
function config(budget: JsonRecord = {}): JsonRecord {
  return { ...TEAM, budget: { enabled: true, weeklyLimitW: 1_000_000_000, overAction: 'ask-lead', sessions: { alpha: { dailyPct: 1 } }, ...budget } };
}

function reply(id: string, input: number): string {
  return replyLine({ id, requestId: `q-${id}`, at: '2030-01-08T09:00:00.000Z', usage: { input } });
}

/** Alpha's tab used `ownW` today, and its subagent 1M W; the lead's tab used 50M W. */
function transcripts(at: number, ownW: number): MemoryTranscripts {
  const source = new MemoryTranscripts();
  source.set(ALPHA_TRANSCRIPT, transcript([reply('a1', ownW)]), at);
  source.set(join(PROJECT, ALPHA_TAB, 'subagents', 'agent-1.jsonl'), transcript([reply('s1', 1_000_000)]), at);
  source.set(LEAD_TRANSCRIPT, transcript([reply('l1', 50_000_000)]), at);
  return source;
}

/** Claude Code's status input: the week `usedPct` used. */
function status(usedPct: number): string {
  return JSON.stringify({ session_id: ALPHA_TAB, cwd: APP, workspace: { current_dir: APP }, rate_limits: { seven_day: { used_percentage: usedPct, resets_at: RESET / 1000 } } });
}

interface World {
  readonly kit: CliHarness;
  readonly hook: (name: string, tab: string, extra?: JsonRecord) => Promise<CliResult>;
}

/** Alpha's and the lead's tabs read their inboxes; alpha used `ownW` + 1M W today; the week is `usedPct` used. */
async function world(budget: JsonRecord, ownW: number, usedPct: number): Promise<World> {
  const kit = new CliHarness(config(budget));
  const source = transcripts(kit.clock.now(), ownW);
  await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
  await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: LEAD_TAB } });
  assert.equal((await kit.run(['statusline'], { stdin: status(usedPct) })).code, EXIT.ok);
  const hook = (name: string, tab: string, extra: JsonRecord = {}): Promise<CliResult> => {
    const path = tab === LEAD_TAB ? LEAD_TRANSCRIPT : ALPHA_TRANSCRIPT;
    return kit.run(['hook', name], { stdin: JSON.stringify({ session_id: tab, cwd: APP, transcript_path: path, ...extra }), transcripts: source });
  };
  return { kit, hook };
}

const AGENT = { tool_name: 'Agent', tool_input: { description: 'search', prompt: 'find it' } };

function messageOf(result: CliResult): string {
  const [line] = result.stdout;
  assert.ok(line !== undefined, 'no output');
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === 'object' && parsed !== null && 'systemMessage' in parsed && typeof parsed.systemMessage === 'string');
  return parsed.systemMessage;
}

async function leadInbox(kit: CliHarness): Promise<string> {
  return (await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: LEAD_TAB } })).stdout.join('\n');
}

describe('the budget in the hooks', () => {
  it('meters the tab and its subagents at the turn end, warns once, and tells the lead once', async () => {
    const { kit, hook } = await world({}, 10_000_000, 30);
    const first = await hook('stop', ALPHA_TAB);
    assert.match(messageOf(first), /^Budget: app-alpha has used 1\.1% of the week today; its daily budget is 1\.0%\. The team is 10\.\d points ahead of its pace line\. The lead has an inbox line\./);
    assert.match(await leadInbox(kit), /alpha: app-alpha is past its daily budget: 1\.1% of the week today against 1\.0%/);
    assert.deepEqual((await hook('stop', ALPHA_TAB)).stdout, []);
    assert.doesNotMatch(await leadInbox(kit), /past its daily budget/);
  });

  it('tells the model with the next prompt, once per level', async () => {
    const { hook } = await world({}, 10_000_000, 30);
    await hook('stop', ALPHA_TAB);
    const prompt = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next' });
    assert.ok(prompt.stdout.some((line) => line.startsWith("teamrig budget: you are past today's budget")), prompt.stdout.join('\n'));
    const again = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'again' });
    assert.ok(!again.stdout.some((line) => line.startsWith('teamrig budget:')));
  });

  it('asks before a helper launch past budget with overAction ask, and lets it go with ask-lead', async () => {
    const asked = await world({ overAction: 'ask' }, 10_000_000, 30);
    const gate = await asked.hook('helper-gate', ALPHA_TAB, AGENT);
    assert.equal(decisionOf(gate), 'ask');
    assert.match(gate.stdout[0] ?? '', /alpha is past its daily budget/);
    const relaxed = await world({}, 10_000_000, 30);
    assert.deepEqual((await relaxed.hook('helper-gate', ALPHA_TAB, AGENT)).stdout, []);
  });

  it('refuses a helper in quiet hours set to block, except for the lead', async () => {
    const { hook } = await world({ quietHours: { startUtc: '09:00', endUtc: '11:00', action: 'block' } }, 1_000_000, 10);
    assert.equal(decisionOf(await hook('helper-gate', ALPHA_TAB, AGENT)), 'deny');
    assert.deepEqual((await hook('helper-gate', LEAD_TAB, AGENT)).stdout, []);
  });

  it('says nothing while the team is behind its pace line, and never posts the lead a line about itself', async () => {
    const behind = await world({}, 10_000_000, 10);
    assert.match(messageOf(await behind.hook('stop', ALPHA_TAB)), /The team is not ahead of its pace line, so nothing more happens\./);
    assert.deepEqual((await behind.hook('helper-gate', ALPHA_TAB, AGENT)).stdout, []);
    const lead = await world({ sessions: { lead: { dailyPct: 1 } } }, 0, 30);
    assert.match(messageOf(await lead.hook('stop', LEAD_TAB)), /^Budget: app-lead has used 5\.0% of the week today/);
    assert.doesNotMatch(await leadInbox(lead.kit), /past its daily budget/);
  });

  it('does nothing with the budget off', async () => {
    const { hook } = await world({ enabled: false, overAction: 'block' }, 10_000_000, 30);
    assert.deepEqual((await hook('stop', ALPHA_TAB)).stdout, []);
    assert.deepEqual((await hook('helper-gate', ALPHA_TAB, AGENT)).stdout, []);
    const prompt = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next' });
    assert.ok(!prompt.stdout.some((line) => line.startsWith('teamrig budget:')));
  });

  it('stays silent and never fails a hook when a newer teamrig wrote the usage files', async () => {
    const { kit, hook } = await world({ overAction: 'block' }, 10_000_000, 30);
    await kit.files.write(join(TEAM_HOME, 'state', 'usage', 'alpha.json'), '{"v":2,"rev":1}');
    for (const result of [await hook('stop', ALPHA_TAB), await hook('helper-gate', ALPHA_TAB, AGENT)]) {
      assert.equal(result.code, EXIT.ok);
      assert.deepEqual(result.stdout, []);
    }
    const prompt = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next' });
    assert.equal(prompt.code, EXIT.ok);
    assert.ok(!prompt.stdout.some((line) => line.startsWith('teamrig budget:')));
  });

  it('prints nothing for a helper launch outside a team or with a bad payload', async () => {
    const { kit } = await world({ overAction: 'block' }, 10_000_000, 30);
    assert.deepEqual((await kit.run(['hook', 'helper-gate'], { stdin: 'not json' })).stdout, []);
    assert.deepEqual((await kit.run(['hook', 'helper-gate'], { stdin: JSON.stringify({ session_id: ALPHA_TAB, cwd: join(USER_HOME, 'elsewhere'), ...AGENT }) })).stdout, []);
  });
});

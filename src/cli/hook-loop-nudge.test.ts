import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { UsageStore } from '../budget/store.ts';
import { MID_TURN_METER_BYTES } from './commands/hook-budget.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { ok } from '../testing/hired-team.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { promptLine, replyLine, resultsLine, transcript, type FixtureTool } from '../testing/transcript-lines.ts';

const AT = '2030-01-08T10:00:00.000Z';
const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);

/** A turn of `count` calls that each ran one Read, the last one with id `last`. */
function readRun(count: number): string {
  const lines = [promptLine(AT)];
  for (let index = 1; index <= count; index += 1) {
    const tool: FixtureTool = { id: index === count ? 'last' : `t${index}`, name: 'Read' };
    lines.push(replyLine({ id: `m${index}`, requestId: `r${index}`, at: AT, usage: { cacheRead: 100_000 }, tools: [tool] }), resultsLine(AT, [{ id: tool.id, text: 'ok' }]));
  }
  return transcript(lines);
}

function payload(extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT, tool_name: 'Read', tool_use_id: 'last', tool_input: { file_path: 'a.ts' }, ...extra });
}

async function nudge(kit: CliHarness, stdin = payload()): Promise<CliResult> {
  return kit.run(['hook', 'loop-nudge'], { stdin });
}

async function kitWithRun(count: number, config = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.files.write(TRANSCRIPT, readRun(count));
  return kit;
}

describe('the loop-nudge hook', () => {
  it('hands the model one line as the run reaches the default 3 calls, and nothing before or after', async () => {
    const at = await nudge(await kitWithRun(3));
    assert.equal(at.code, 0);
    assert.deepEqual(JSON.parse(at.stdout.join('')), {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          'teamrig: 3 single-step calls in a row this turn (about 20k W of re-reads at this context); send independent reads and lookups as several tool calls in one message, join shell steps into one command, and send an edit with its re-test.',
      },
    });
    assert.deepEqual((await nudge(await kitWithRun(2))).stdout, []);
    assert.deepEqual((await nudge(await kitWithRun(4))).stdout, []);
  });

  it('follows loops.chainNudgeAt, and 0 turns it off', async () => {
    assert.equal((await nudge(await kitWithRun(5, { ...TEAM, loops: { chainNudgeAt: 5 } }))).stdout.length, 1);
    assert.deepEqual((await nudge(await kitWithRun(3, { ...TEAM, loops: { chainNudgeAt: 5 } }))).stdout, []);
    assert.deepEqual((await nudge(await kitWithRun(3, { ...TEAM, loops: { chainNudgeAt: 0 } }))).stdout, []);
  });

  it("skips a helper's call, which carries agent_id", async () => {
    assert.deepEqual((await nudge(await kitWithRun(3), payload({ agent_id: 'helper-1' }))).stdout, []);
  });

  it('prints nothing outside a team, without a transcript, for bad input or when the transcript cannot be read', async () => {
    const noTeam = new CliHarness(TEAM, null);
    await noTeam.files.write(TRANSCRIPT, readRun(3));
    assert.deepEqual((await nudge(noTeam)).stdout, []);
    assert.deepEqual((await nudge(new CliHarness(TEAM))).stdout, []);
    assert.deepEqual((await nudge(await kitWithRun(3), 'not json')).stdout, []);
    const kit = await kitWithRun(3);
    const failing = await kit.run(['hook', 'loop-nudge'], { stdin: payload(), files: new FaultyFiles(kit.files).fail('readTail', TRANSCRIPT, systemError('EIO')) });
    assert.equal(failing.code, 0);
    assert.deepEqual(failing.stdout, []);
  });
});

describe('the loop-nudge hook meters a long turn (T3298)', () => {
  const USAGE = join(TEAM_HOME, 'state', 'usage');
  const BUDGET_TEAM = { ...TEAM, budget: { enabled: true, weeklyLimitW: 1_000_000_000 } };
  /** A line no meter counts, so a transcript reaches a size without more W. */
  const padLine = (bytes: number): string => `${JSON.stringify({ type: 'summary', pad: 'x'.repeat(bytes) })}\n`;

  /** A team on the budget whose alpha owns this tab, its transcript one reply of 2M input W plus `padBytes`. */
  async function alphaTab(config: Readonly<Record<string, unknown>>, padBytes: number): Promise<{ kit: CliHarness; source: MemoryTranscripts }> {
    const kit = new CliHarness(config);
    ok(await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } }));
    const source = new MemoryTranscripts();
    const reply = replyLine({ id: 'm1', requestId: 'r1', at: AT, usage: { input: 2_000_000 }, tools: [{ id: 'last', name: 'Read' }] });
    const text = transcript([promptLine(AT), reply]) + padLine(padBytes);
    source.set(TRANSCRIPT, text, kit.clock.now());
    await kit.files.write(TRANSCRIPT, text);
    return { kit, source };
  }

  async function alphaToday(kit: CliHarness): Promise<number | undefined> {
    return (await new UsageStore(kit.files, USAGE).load('alpha')).state.byDay['2030-01-08']?.w;
  }

  it("meters the tab at a call once its transcript has grown a megabyte past the stored cursor, before the turn's Stop", async () => {
    const { kit, source } = await alphaTab(BUDGET_TEAM, MID_TURN_METER_BYTES);
    assert.equal((await kit.run(['hook', 'loop-nudge'], { stdin: payload(), transcripts: source })).code, 0);
    assert.equal(await alphaToday(kit), 2_000_000);
  });

  it('leaves a tab that grew less than that for a later call or the Stop hook, and meters nothing with the budget off', async () => {
    const small = await alphaTab(BUDGET_TEAM, 1000);
    await small.kit.run(['hook', 'loop-nudge'], { stdin: payload(), transcripts: small.source });
    assert.equal(await alphaToday(small.kit), undefined);
    const off = await alphaTab(TEAM, MID_TURN_METER_BYTES);
    await off.kit.run(['hook', 'loop-nudge'], { stdin: payload(), transcripts: off.source });
    assert.equal(await alphaToday(off.kit), undefined);
  });

  it("skips a helper's call: its tab's own calls meter it, helpers included", async () => {
    const { kit, source } = await alphaTab(BUDGET_TEAM, MID_TURN_METER_BYTES);
    await kit.run(['hook', 'loop-nudge'], { stdin: payload({ agent_id: 'helper-1' }), transcripts: source });
    assert.equal(await alphaToday(kit), undefined);
  });
});

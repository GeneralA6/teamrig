import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
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

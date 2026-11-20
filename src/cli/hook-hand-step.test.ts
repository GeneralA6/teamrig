import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { HostSource } from '../composition/host-ports.ts';
import { HOOKS_ONLY_HOST } from '../testing/host.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { promptLine, textLine, transcript } from '../testing/transcript-lines.ts';

const AT = '2030-01-08T10:00:00.000Z';
const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const FENCE = '```';
const HAND_STEP = `Run this to allow it:\n${FENCE}powershell\nSet-Content C:\\Work\\app\\settings.json '{}'\n${FENCE}`;
const ENV = { TEAMRIG_SESSION: 'alpha' };

/** A turn whose reply is `texts`, after an earlier turn that handed a step `before`. */
function turn(texts: readonly string[], before: readonly string[] = []): string {
  return transcript([promptLine(AT, 'old'), textLine('u0', before.length === 0 ? ['ok'] : before), promptLine(AT, 'go'), textLine('u1', texts)]);
}

function stdin(extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT, stop_hook_active: false, ...extra });
}

async function stop(kit: CliHarness, input = stdin(), env: Readonly<Record<string, string>> = ENV): Promise<CliResult> {
  return kit.run(['hook', 'stop'], { stdin: input, env });
}

async function kitWith(text: string, kit = new CliHarness(TEAM)): Promise<CliHarness> {
  await kit.files.write(TRANSCRIPT, text);
  return kit;
}

/** The block's reason, or undefined when the hook printed no block. */
function blockReason(result: CliResult): string | undefined {
  const out = result.stdout.join('');
  if (out === '') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(out);
  return typeof parsed === 'object' && parsed !== null && 'decision' in parsed && parsed.decision === 'block' && 'reason' in parsed && typeof parsed.reason === 'string'
    ? parsed.reason
    : undefined;
}

describe('the stop hook on a hand step typed into the reply (core rule 11)', () => {
  it('sends a team session back once when its turn handed the human a shell block with no sha256', async () => {
    const kit = await kitWith(turn([HAND_STEP]));
    const first = await stop(kit);
    assert.equal(first.code, 0);
    assert.match(blockReason(first) ?? '', /^teamrig: your reply handed the human a shell block with no pinned sha256\. Core rule 11/);
    assert.doesNotMatch(blockReason(await stop(kit, stdin({ stop_hook_active: true }))) ?? '', /Core rule 11/);
  });

  it('reads the last message Claude Code hands the hook when the transcript does not hold it yet', async () => {
    const kit = await kitWith(turn(['Checking.']));
    assert.match(blockReason(await stop(kit, stdin({ last_assistant_message: HAND_STEP }))) ?? '', /Core rule 11/);
  });

  it('reads that last message alone on a host whose transcript teamrig cannot read', async () => {
    const bare: HostSource = HOOKS_ONLY_HOST;
    const unread = await kitWith(turn([HAND_STEP]));
    assert.equal(blockReason(await unread.run(['hook', 'stop'], { stdin: stdin(), env: ENV, host: bare })), undefined);
    const handed = await kitWith(turn(['Checking.']));
    assert.match(blockReason(await handed.run(['hook', 'stop'], { stdin: stdin({ last_assistant_message: HAND_STEP }), env: ENV, host: bare })) ?? '', /Core rule 11/);
  });

  it("lets a turn by that pins the file, marks the block read-only, or only an earlier turn's reply typed one", async () => {
    for (const reply of [`run: & 'C:\\Work\\app\\tasks\\T7\\fix.ps1'   (sha256 7a0d9294, audited by beta)`, `Read-only check:\n${FENCE}bash\ngit status\n${FENCE}`, 'Done.']) {
      assert.doesNotMatch(blockReason(await stop(await kitWith(turn([reply])))) ?? '', /Core rule 11/, reply);
    }
    assert.doesNotMatch(blockReason(await stop(await kitWith(turn(['Done.'], [HAND_STEP])))) ?? '', /Core rule 11/);
  });

  it('prints no block outside a team, in a tab that is no session of it, or when the transcript cannot be read', async () => {
    assert.deepEqual((await stop(await kitWith(turn([HAND_STEP]), new CliHarness(TEAM, null)))).stdout, []);
    assert.equal(blockReason(await stop(await kitWith(turn([HAND_STEP])), stdin(), {})), undefined);
    const kit = await kitWith(turn([HAND_STEP]));
    const failing = await kit.run(['hook', 'stop'], { stdin: stdin(), env: ENV, files: new FaultyFiles(kit.files).fail('readTail', TRANSCRIPT, systemError('EIO')) });
    assert.equal(failing.code, 0);
    assert.doesNotMatch(blockReason(failing) ?? '', /Core rule 11/);
  });
});

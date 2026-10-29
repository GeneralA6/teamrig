import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, KIT, TEAM, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const HISTORY = join(USER_HOME, '.claude', 'history.jsonl');
const PENDING = join(KIT, 'history-clean', 'pending');
const CLEAN_LOG = join(KIT, 'history-clean', 'log.jsonl');
const ALPHA = { TEAMRIG_SESSION: 'alpha' };
const TEN_MINUTES = 10 * 60 * 1000;

/** Secret-shaped strings are assembled at runtime so none sits in the source. */
const TOKEN = ['gh', 'p_', 'Q7'.repeat(18)].join('');

function prompt(text: string): string {
  return JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: CLAUDE_SESSION, cwd: APP, prompt: text });
}

function historyLine(display: string): string {
  return `${JSON.stringify({ display, pastedContents: {}, timestamp: 1, project: APP })}\n`;
}

/** The block's reason, after checking the hook printed only a UserPromptSubmit block that keeps the prompt out of the transcript. */
function blockReason(result: CliResult): string {
  assert.equal(result.code, EXIT.ok);
  assert.equal(result.stdout.length, 1);
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
  assert.ok(isRecord(parsed));
  assert.equal(parsed['decision'], 'block');
  assert.deepEqual(recordField(parsed, 'hookSpecificOutput'), { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true });
  const reason = stringField(parsed, 'reason');
  assert.ok(reason !== undefined);
  assert.ok(!reason.includes(TOKEN));
  return reason;
}

describe('hook inbox-reminder: a prompt that holds a secret', () => {
  it('is stopped, cleaned out of the prompt history and logged nowhere; its inbox lines wait for the next prompt', async () => {
    const kit = new CliHarness(TEAM);
    await kit.run(['inbox', 'add', '--to', 'alpha', '--text', 'T7 is yours', '--session', 'lead']);
    await kit.files.write(HISTORY, historyLine(`use ${TOKEN} for the push`) + historyLine('fix the build'));
    const reason = blockReason(await kit.run(['hook', 'inbox-reminder'], { stdin: prompt(`push with ${TOKEN}`), env: ALPHA }));
    assert.match(reason, /holds a secret \(GitHub token\)/);
    assert.match(reason, /Removed from Claude Code's prompt history: 1 line and 0 pasted texts that held it\.$/);
    assert.equal(kit.files.get(HISTORY), historyLine('fix the build'));
    assert.equal((await kit.files.list(PENDING)).length, 1);
    assert.deepEqual(
      kit.files.paths().filter((path) => path.includes('turn-log')),
      [],
    );
    const next = await kit.run(['hook', 'inbox-reminder'], { stdin: prompt('go on'), env: ALPHA });
    assert.match(next.stdout.join('\n'), /lead: T7 is yours/);
  });

  it('is cleaned again at later prompts until its record settles 10 minutes after the block', async () => {
    const kit = new CliHarness(TEAM);
    await kit.run(['hook', 'inbox-reminder'], { stdin: prompt(`push with ${TOKEN}`), env: ALPHA });
    // Claude Code wrote the stopped prompt's line after the hook ran.
    await kit.files.write(HISTORY, historyLine(`push with ${TOKEN}`) + historyLine('fix the build'));
    await kit.run(['hook', 'inbox-reminder'], { stdin: prompt('go on'), env: ALPHA });
    assert.equal(kit.files.get(HISTORY), historyLine('fix the build'));
    // Its line was found and removed, so the record settles at once.
    assert.deepEqual(await kit.files.list(PENDING), []);
    await kit.run(['hook', 'inbox-reminder'], { stdin: prompt(`again ${TOKEN}`), env: ALPHA });
    await kit.run(['hook', 'inbox-reminder'], { stdin: prompt('go on'), env: ALPHA });
    assert.equal((await kit.files.list(PENDING)).length, 1);
    kit.clock.advance(TEN_MINUTES);
    await kit.run(['hook', 'inbox-reminder'], { stdin: prompt('go on'), env: ALPHA });
    assert.deepEqual(await kit.files.list(PENDING), []);
  });

  it("is stopped by the team config's own secret patterns", async () => {
    const kit = new CliHarness({ ...TEAM, register: { secretPatterns: ['corp-[0-9]{8}'] } });
    assert.match(blockReason(await kit.run(['hook', 'inbox-reminder'], { stdin: prompt('key corp-12345678'), env: ALPHA })), /secret pattern from the team config/);
  });

  it('is stopped when the history clean fails, which the next prompt tries again', async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(HISTORY, historyLine(`use ${TOKEN}`));
    const files = new FaultyFiles(kit.files).fail('write', HISTORY, systemError('EPERM'));
    assert.match(blockReason(await kit.run(['hook', 'inbox-reminder'], { stdin: prompt(`push with ${TOKEN}`), env: ALPHA, files })), /failed; your next prompt tries again\.$/);
    await kit.run(['hook', 'inbox-reminder'], { stdin: prompt('go on'), env: ALPHA });
    assert.equal(kit.files.get(HISTORY), '');
  });

  it('is stopped when its clean cannot be recorded, saying an earlier prompt may stay in the history', async () => {
    const kit = new CliHarness(TEAM);
    const files = new FaultyFiles(kit.files).fail('append', CLEAN_LOG, systemError('EPERM'));
    assert.match(blockReason(await kit.run(['hook', 'inbox-reminder'], { stdin: prompt(`push with ${TOKEN}`), env: ALPHA, files })), /may stay in history\.jsonl\.$/);
  });
});

describe('hook inbox-reminder: a prompt with no secret', () => {
  it('goes through with its inbox lines when the sweep of earlier blocked prompts fails', async () => {
    const kit = new CliHarness(TEAM);
    await kit.run(['inbox', 'add', '--to', 'alpha', '--text', 'T7 is yours', '--session', 'lead']);
    const files = new FaultyFiles(kit.files).fail('list', PENDING, systemError('EACCES'));
    const result = await kit.run(['hook', 'inbox-reminder'], { stdin: prompt('go on'), env: ALPHA, files });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout.join('\n'), /lead: T7 is yours/);
    assert.doesNotMatch(result.stdout.join('\n'), /"decision"/);
  });

  it('is stopped under a broken team pointer too, and left alone outside a team', async () => {
    const broken = new CliHarness(TEAM, '{"team": 7}');
    assert.match(blockReason(await broken.run(['hook', 'inbox-reminder'], { stdin: prompt(`push with ${TOKEN}`) })), /GitHub token/);
    const outside = new CliHarness(TEAM, null);
    await outside.files.write(HISTORY, historyLine(`use ${TOKEN}`));
    assert.deepEqual((await outside.run(['hook', 'inbox-reminder'], { stdin: prompt(`push with ${TOKEN}`) })).stdout, []);
    assert.equal(outside.files.get(HISTORY), historyLine(`use ${TOKEN}`));
  });
});

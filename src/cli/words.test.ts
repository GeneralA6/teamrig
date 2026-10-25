import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { APP, bash, CLAUDE_SESSION, CliHarness, TEAM_HOME, USER_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** Any emoji-like character: what T242 keeps out of everything teamrig prints. */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
/** The markers teamrig and its docs used before T242, named one by one: ↻, ✓ and ✗ are outside Extended_Pictographic. */
const OLD_MARKERS = ['↻', '✅', '🚧', '🗺', '⚠', '⛔', '⏸', '✓', '✗'];

const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'app', `${CLAUDE_SESSION}.jsonl`);
const HANDOVER = join(TEAM_HOME, 'handover', 'alpha.md');
const AS_ALPHA: RunOptions = { env: { TEAMRIG_SESSION: 'alpha' } };
const AS_BRAVO: RunOptions = { env: { TEAMRIG_SESSION: 'bravo', CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } };

/** A transcript whose last reply read 300k tokens of context, over the default refresh threshold. */
function bigTranscript(): string {
  const reply = { type: 'assistant', isSidechain: false, message: { usage: { input_tokens: 2, cache_read_input_tokens: 299_998, output_tokens: 9 } } };
  return `${JSON.stringify({ type: 'user', isSidechain: false, message: { content: 'go' } })}\n${JSON.stringify(reply)}\n`;
}

function hookInput(extra: Readonly<Record<string, string | boolean>> = {}): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT, ...extra });
}

/**
 * Runs every command and hook over a team whose tasks take each shape a line can print: overdue,
 * waiting, done, dropped and re-prioritized, a note waiting in an inbox, a refresh asked and ready,
 * pushes asked and refused, and refusals of bad input. Returns what each one printed.
 */
async function everyOutput(): Promise<string[]> {
  const kit = new CliHarness();
  await kit.files.write(TRANSCRIPT, bigTranscript());
  const steps: [readonly string[], RunOptions?][] = [
    [['add', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--due', '2030-01-07', '--week', '2030-01-07', '--session', 'lead']],
    [['add', '--title', 'Trim the cache', '--description', 'what and why', '--priority', 'p2', '--owner', 'bravo', '--week', '2030-01-07', '--session', 'lead']],
    [['set', 'T2', '--status', 'blocked', '--note', 'waiting on disk', '--session', 'bravo']],
    [['set', 'T2', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'waiting on disk', ...TEST_OWNER_CARD_FLAGS, '--session', 'bravo']],
    [['add', '--title', 'Old idea', '--description', 'what and why', '--priority', 'p3', '--session', 'alpha']],
    [['set', 'T3', '--status', 'dropped', '--note', 'merged into T1', '--session', 'alpha']],
    [['update', 'T1', '--priority', 'p2', '--note', 'after the release', '--session', 'lead']],
    [['add', '--title', 'Bad priority', '--description', 'what and why', '--priority', 'p9', '--session', 'lead']],
    [['add', '--title', 'Old flag', '--description', 'what and why', '--tier', '2', '--session', 'lead']],
    [['list', '--priority', 't2', '--session', 'lead']],
    [['inbox', 'add', '--to', 'bravo', '--text', 'T2 has its disk', '--session', 'lead']],
    [['inbox', 'status', '--session', 'bravo']],
    [['hook', 'inbox-reminder'], { ...AS_BRAVO, stdin: hookInput() }],
    [['hook', 'inbox-reminder'], { stdin: hookInput({ session_title: 'Fix it' }) }],
    [['inbox', 'read', '--session', 'bravo'], AS_BRAVO],
    [['list', '--status', 'all', '--session', 'lead']],
    [['list', '--priority', 'p1,p2', '--session', 'lead']],
    [['show', 'T1', '--session', 'lead']],
    [['show', 'T2', '--session', 'lead']],
    [['check', '--week', '2030-01-07', '--session', 'lead']],
    [['plan', '--week', '2030-01-07', '--session', 'lead']],
    [['who']],
    [['rules', '--session', 'alpha']],
    [['team', 'tree']],
    [['doctor']],
    [['config', 'validate']],
    [['help']],
    [['hook', 'session-start'], { ...AS_ALPHA, stdin: hookInput({ source: 'startup' }) }],
    [['hook', 'push-guard'], { stdin: bash('git push origin main') }],
    [['hook', 'push-guard'], { stdin: bash('git push --force origin main') }],
    [['add', '--title', 'Ship it', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']],
    [['set', 'T4', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--session', 'alpha']],
    [['hook', 'stop'], { ...AS_ALPHA, stdin: hookInput({ stop_hook_active: false }) }],
    [['refresh', '--ready', '--session', 'alpha']],
  ];
  const printed: string[] = [];
  const record = async (argv: readonly string[], options: RunOptions = {}): Promise<void> => {
    const result = await kit.run(argv, options);
    printed.push([`$ ${argv.join(' ')} (exit ${result.code})`, ...result.stdout, ...result.stderr].join('\n'));
  };
  for (const [argv, options] of steps) {
    await record(argv, options);
  }
  await kit.files.write(HANDOVER, '# In progress\n- T1: tests left\n');
  await record(['refresh', '--ready', '--session', 'alpha']);
  await record(['hook', 'stop'], { ...AS_ALPHA, stdin: hookInput({ stop_hook_active: true }) });
  await record(['hook', 'session-start'], { ...AS_ALPHA, stdin: hookInput({ source: 'clear' }) });
  return printed;
}

describe('runCli: every output speaks in words, with no pictograph markers (T242)', () => {
  it('prints every command, refusal and hook line without one', async () => {
    const printed = await everyOutput();
    const all = printed.join('\n');
    // The run really reaches the shapes markers once stood for.
    for (const words of [
      'OVERDUE',
      'waiting: decision owner',
      'blocked was replaced by waiting',
      'dropped',
      'done',
      'priority=p2',
      'REFUSED priority p9 is not one of p1, p2, p3, p4, p5',
      '--tier was renamed: use --priority',
      'is the old tier spelling: write p2',
      'INBOX bravo, new in',
      'so it is not bound',
      '"permissionDecision":"ask"',
      '"permissionDecision":"deny"',
      'Write your handover',
      'alpha: type /clear',
      'read your handover first',
    ]) {
      assert.ok(all.includes(words), `no output printed "${words}"`);
    }
    assert.ok(!printed.some((text) => text.includes(`(exit ${EXIT.failed})`)), all);
    for (const text of printed) {
      assert.doesNotMatch(text, PICTOGRAPH, text);
      for (const marker of OLD_MARKERS) {
        assert.ok(!text.includes(marker), `${marker} in:\n${text}`);
      }
    }
  });
});

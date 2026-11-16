import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScanner } from '../core/secrets.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { TabNeed } from './need.ts';
import type { AskingTab } from './needs-you.ts';
import { heldPrompts, PROMPT_HOLD_MS, PromptHoldsPaged, promptHoldText, promptWords } from './prompt-hold.ts';

const PAGED = '/team/state/prompt-holds-paged.json';
const SINCE = Date.parse('2030-01-08T10:00:00.000Z');
const HELD: AskingTab = { session: 'bravo', state: 'waiting', kind: 'permission', text: 'Bash: git status --short', task: null, pid: 7100, since: new Date(SINCE).toISOString() };
const ANSWERED: TabNeed = { ...HELD, session: 'alpha', state: 'working', kind: null, text: null };
const QUESTION: AskingTab = { ...HELD, session: 'charlie', kind: 'question', text: 'Which one?' };
const alive = (): boolean => true;
const SCANNER = new SecretScanner();
/** A GitHub token's shape, built here so no token-looking text sits in the source. */
const TOKEN = `gh${'p'}_${'aB3'.repeat(12)}`;

describe('heldPrompts', () => {
  it('keeps a permission prompt unanswered for the hold time, and no other ask', () => {
    assert.deepEqual(heldPrompts([HELD, ANSWERED, QUESTION], SINCE + PROMPT_HOLD_MS, alive), [HELD]);
  });

  it('keeps none a minute short of the hold time', () => {
    assert.deepEqual(heldPrompts([HELD], SINCE + PROMPT_HOLD_MS - 60_000, alive), []);
  });

  it('keeps none whose Claude Code no longer runs: a closed tab asks nothing', () => {
    assert.deepEqual(heldPrompts([HELD], SINCE + PROMPT_HOLD_MS, () => false), []);
    assert.deepEqual(heldPrompts([{ ...HELD, pid: null }], SINCE + PROMPT_HOLD_MS, () => false), [{ ...HELD, pid: null }]);
  });
});

describe('promptWords', () => {
  it('names the tool and the program, the first word of its detail', () => {
    assert.equal(promptWords('Bash: git status --short', SCANNER), 'Bash git');
    assert.equal(promptWords('Bash: npm run check now', SCANNER), 'Bash npm');
  });

  it('drops a short lowercase secret in the words after the program, where an argument sits (T2963)', () => {
    assert.equal(promptWords('Bash: mysql hunter2pass now', SCANNER), 'Bash mysql');
    assert.equal(promptWords(`Bash: unlock ${'c0ffee'.repeat(3)}`, SCANNER), 'Bash unlock');
  });

  it('stops at the first word that may hold a path, an address or a value', () => {
    assert.equal(promptWords('Bash: rm -rf /srv/data/x', SCANNER), 'Bash rm');
    assert.equal(promptWords('Edit: D:/work/repo/file.ts', SCANNER), 'Edit');
    assert.equal(promptWords('Bash: TOKEN=abc curl https://example.test', SCANNER), 'Bash');
    assert.equal(promptWords('WebFetch', SCANNER), 'WebFetch');
  });

  it('stops at a bare token: an echoed token, a long lowercase hex key, a mixed-case word', () => {
    assert.equal(promptWords(`Bash: echo ${TOKEN} | gh auth login --with-token`, SCANNER), 'Bash echo');
    assert.equal(promptWords(`Bash: deploy ${'a3f9'.repeat(10)} now`, SCANNER), 'Bash deploy');
    assert.equal(promptWords('Bash: login Xk9vQ2 now', SCANNER), 'Bash login');
  });

  it('names the tool alone when the program word matches a secret shape the team configured', () => {
    assert.equal(promptWords('Bash: hunter2 now', new SecretScanner(['hunter2'])), 'Bash');
  });
});

describe('promptHoldText', () => {
  it('names the tab, the time on its clock, the minutes held and the program', () => {
    const text = promptHoldText('app/bravo', HELD, () => '12:00 IST', SCANNER, SINCE + 12 * 60_000);
    assert.equal(text, 'app/bravo holds on a permission prompt since 12:00 IST (12 min): Bash git; answer it in that tab');
  });
});

describe('PromptHoldsPaged', () => {
  it('pages each hold once, a new hold of the same tab again, and forgets tabs that hold nothing now', async () => {
    const files = new MemoryFiles();
    const paged = new PromptHoldsPaged(files, PAGED);
    assert.deepEqual(await paged.unpaged([HELD]), [HELD]);
    await paged.keep([HELD], []);
    assert.deepEqual(await paged.unpaged([HELD]), []);
    const next = { ...HELD, since: '2030-01-08T11:00:00.000Z' };
    assert.deepEqual(await paged.unpaged([next]), [next]);
    await paged.keep([], []);
    assert.deepEqual(JSON.parse((await files.read(PAGED)) ?? ''), {});
    assert.deepEqual(await paged.unpaged([HELD]), [HELD], 'the answered hold was forgotten');
  });

  it('keeps a hold whose page failed unpaged, so the next pass tries again', async () => {
    const paged = new PromptHoldsPaged(new MemoryFiles(), PAGED);
    await paged.keep([HELD], [HELD]);
    assert.deepEqual(await paged.unpaged([HELD]), [HELD]);
  });
});

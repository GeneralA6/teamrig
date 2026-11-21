import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MemoryFiles } from '../testing/memory-files.ts';
import { PromptMarks, promptMarksDir } from './prompt-marks.ts';

const KIT = join('/', 'kit');
const DIR = promptMarksDir(KIT);
const TAB = '0123abcd-0000-4000-8000-00000000000a';
const OTHER_TAB = '0123abcd-0000-4000-8000-00000000000b';
const AT = Date.parse('2030-01-08T10:00:00Z');
const WOKE = 'New work was handed to you while this tab was idle: T2.';

describe('PromptMarks', () => {
  it("keeps a mark per tab and per fresh launch's team session beside the restore's sessions, the later in place of the earlier", async () => {
    const files = new MemoryFiles();
    const marks = new PromptMarks(files, DIR);
    assert.equal(DIR, join(KIT, 'restore', 'prompts'));
    await marks.mark({ tab: TAB }, 'first', AT);
    await marks.mark({ tab: TAB }, WOKE, AT);
    await marks.mark({ team: 'app', session: 'alpha' }, 'You are the alpha session of team app.', AT);
    assert.equal(await marks.read({ tab: TAB }), WOKE);
    assert.deepEqual(JSON.parse(files.get(join(DIR, `${TAB}.json`)) ?? ''), { v: 1, text: WOKE, at: '2030-01-08T10:00:00.000Z' });
    assert.equal(await marks.read({ team: 'app', session: 'alpha' }), 'You are the alpha session of team app.');
    assert.notEqual(files.get(join(DIR, 'app.alpha.json')), undefined);
  });

  it('takes a mark once, under the first key whose text matches exactly, outer white space aside', async () => {
    const files = new MemoryFiles();
    const marks = new PromptMarks(files, DIR);
    await marks.mark({ tab: TAB }, WOKE, AT);
    await marks.mark({ team: 'app', session: 'alpha' }, 'the first prompt', AT);
    assert.equal(await marks.take([{ tab: OTHER_TAB }], WOKE), false, 'another tab');
    assert.equal(await marks.take([{ tab: TAB }], 'New work was handed to you: T2.'), false, 'a text the person edited is theirs');
    assert.equal(await marks.take([{ tab: TAB }, { team: 'app', session: 'alpha' }], ` ${WOKE}\n`), true);
    assert.equal(await marks.read({ tab: TAB }), undefined);
    assert.equal(await marks.take([{ tab: TAB }], WOKE), false, 'the same text typed again is the owner’s');
    assert.equal(await marks.take([{ tab: TAB }, { team: 'app', session: 'alpha' }], 'the first prompt'), true, "a fresh launch's mark, by its team session");
    assert.equal(await marks.take([{ tab: TAB }, { team: 'app', session: 'alpha' }], 'the first prompt'), false);
  });

  it('forgets a dropped prompt, and reads a damaged file or one of another format as no mark', async () => {
    const files = new MemoryFiles();
    const marks = new PromptMarks(files, DIR);
    await marks.mark({ tab: TAB }, WOKE, AT);
    await marks.forget({ tab: TAB });
    assert.equal(await marks.take([{ tab: TAB }], WOKE), false);
    for (const text of ['{not json', JSON.stringify({ v: 2, text: WOKE }), JSON.stringify({ v: 1 })]) {
      await files.write(join(DIR, `${TAB}.json`), text);
      assert.equal(await marks.take([{ tab: TAB }], WOKE), false, text);
    }
  });

  it('names a file by a Claude Code session id or two team ids only, so no payload text reaches a path', async () => {
    const marks = new PromptMarks(new MemoryFiles(), DIR);
    await assert.rejects(marks.mark({ tab: '../x' }, WOKE, AT));
    await assert.rejects(marks.mark({ team: 'app', session: '../x' }, WOKE, AT));
    await assert.rejects(marks.mark({ team: 'A.b', session: 'alpha' }, WOKE, AT));
  });
});

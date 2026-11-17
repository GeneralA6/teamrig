import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlainLogFile } from '../core/log-file.ts';
import { TimeZone } from '../core/zone.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { InboxDeps } from './inbox.ts';
import { fitLines, injectFor, injectionOf, type InjectionInput } from './inject.ts';
import { lineHash } from './line-hash.ts';
import type { InboxMark } from './marks.ts';
import { cutWhenShown, INJECT_CAPS, newestShownOf, unshownOf } from './shown.ts';
import { InboxDir, JsonlMarkLog } from './store.ts';

const DIR = 'state/inbox';
const MARKS = 'state/inbox-marks.jsonl';
const SHOWN = 'state/inbox-shown.jsonl';
const TAB = '0a1b2c3d-1111-2222-3333-444455556666';
const OTHER_TAB = '9f8e7d6c-1111-2222-3333-444455556666';
const NOW = new Date('2030-01-08T10:00:00Z');
const LINES = Array.from({ length: 8 }, (_, index) => `- 2030-01-07 0${index}:00 lead: item ${index + 1}`);
/** LINES as a session on UTC is shown them. */
const SHOWN_LINES = Array.from({ length: 8 }, (_, index) => `- 2030-01-07 0${index}:00 UTC lead: item ${index + 1}`);

function markAt(lines: readonly string[], through: number, claudeSession: string | null, area = 'alpha'): InboxMark {
  const last = lines[through - 1];
  return { v: 1, area, line: through, at: NOW.toISOString(), claudeSession, lastLineHash: last === undefined ? null : lineHash(last) };
}

function input(fields: Partial<InjectionInput> = {}): InjectionInput {
  return { area: 'alpha', path: `${DIR}/alpha.md`, lines: LINES.slice(0, 3), read: null, shown: null, claudeSession: TAB, now: NOW, zone: TimeZone.UTC, command: 'teamrig', ...fields };
}

describe('newestShownOf and unshownOf', () => {
  it("finds the newest shown mark of this Claude Code session and area only", () => {
    const marks = [markAt(LINES, 1, TAB), markAt(LINES, 2, OTHER_TAB), markAt(LINES, 3, TAB, 'bravo'), markAt(LINES, 2, TAB)];
    assert.deepEqual(newestShownOf(marks, 'alpha', TAB), marks[3]);
    assert.equal(newestShownOf(marks, 'charlie', TAB), null);
    assert.equal(newestShownOf(marks, 'alpha', null), null, 'outside Claude Code nothing was shown');
  });

  it('starts after the later of the read and the shown mark, and ignores a shown mark whose line is gone', () => {
    assert.deepEqual(unshownOf('alpha', LINES, null, null, lineHash), LINES);
    assert.deepEqual(unshownOf('alpha', LINES, markAt(LINES, 2, null), markAt(LINES, 5, TAB), lineHash), LINES.slice(5));
    assert.deepEqual(unshownOf('alpha', LINES, markAt(LINES, 6, null), markAt(LINES, 5, TAB), lineHash), LINES.slice(6), 'read after it was shown');
    const gone = { ...markAt(LINES, 5, TAB), lastLineHash: lineHash('rewritten away') };
    assert.deepEqual(unshownOf('alpha', LINES, markAt(LINES, 2, null), gone, lineHash), LINES.slice(2));
  });

  it('counts a line as cut when it is longer than the character cap', () => {
    assert.equal(cutWhenShown('x'.repeat(INJECT_CAPS.maxChars)), false);
    assert.equal(cutWhenShown('x'.repeat(INJECT_CAPS.maxChars + 1)), true);
  });
});

describe('fitLines', () => {
  const caps = { maxLines: 3, maxChars: 20 };

  it('takes lines up to the line cap and the character cap', () => {
    assert.deepEqual(fitLines(['a', 'b', 'c', 'd'], caps), ['a', 'b', 'c']);
    assert.deepEqual(fitLines(['x'.repeat(12), 'y'.repeat(8), 'z'], caps), ['x'.repeat(12), 'y'.repeat(8)]);
    assert.deepEqual(fitLines(['x'.repeat(12), 'y'.repeat(9)], caps), ['x'.repeat(12)]);
    assert.deepEqual(fitLines([], caps), []);
  });

  it('cuts a first line longer than the character cap, and stops after it', () => {
    assert.deepEqual(fitLines(['x'.repeat(25), 'b'], caps), [`${'x'.repeat(20)}…`]);
  });
});

describe('injectionOf', () => {
  it('shows every new line with a header, and marks them shown and read through the last', () => {
    const injection = injectionOf(input());
    assert.deepEqual(injection?.text.split('\n'), [
      `INBOX alpha, new in ${DIR}/alpha.md (each line is shown once, and marked read once shown whole):`,
      ...SHOWN_LINES.slice(0, 3),
    ]);
    assert.deepEqual(injection?.shown, markAt(LINES, 3, TAB));
    assert.deepEqual(injection?.read, markAt(LINES, 3, TAB));
  });

  it('shows five lines at most and says how many wait', () => {
    const injection = injectionOf(input({ lines: LINES, read: markAt(LINES, 1, null) }));
    assert.deepEqual(injection?.text.split('\n').slice(1), [
      ...SHOWN_LINES.slice(1, 6),
      '+2 more at your next prompt, or all now with: teamrig inbox read --session alpha',
    ]);
    assert.deepEqual(injection?.shown, markAt(LINES, 6, TAB));
    assert.deepEqual(injection?.read, markAt(LINES, 6, TAB), 'the lines past the cap stay unread');
    const next = injectionOf(input({ lines: LINES, read: markAt(LINES, 1, null), shown: injection?.shown ?? null }));
    assert.deepEqual(next?.text.split('\n').slice(1), SHOWN_LINES.slice(6));
    assert.equal(injectionOf(input({ lines: LINES, read: markAt(LINES, 1, null), shown: next?.shown ?? null })), undefined);
  });

  it('cuts one long line to the cap and says where to read it whole', () => {
    const long = `- 2030-01-07 09:00 lead: ${'x'.repeat(INJECT_CAPS.maxChars)}`;
    const text = injectionOf(input({ lines: [long, LINES[0] ?? ''] }))?.text.split('\n') ?? [];
    assert.equal(text[1]?.length, INJECT_CAPS.maxChars + 1);
    assert.deepEqual(text.slice(2), [
      `The line above was cut at ${INJECT_CAPS.maxChars} characters; \`teamrig inbox read --session alpha\` prints it whole.`,
      '+1 more at your next prompt, or all now with: teamrig inbox read --session alpha',
    ]);
  });

  it('reads nothing past a line cut to fit, so inbox read still prints it whole', () => {
    const long = `- 2030-01-07 09:00 lead: ${'x'.repeat(INJECT_CAPS.maxChars)}`;
    const lines = [LINES[0] ?? '', long, LINES[1] ?? ''];
    const first = injectionOf(input({ lines }));
    assert.deepEqual(first?.shown, markAt(lines, 1, TAB));
    assert.deepEqual(first?.read, markAt(lines, 1, TAB), 'the whole line before it is read');
    const second = injectionOf(input({ lines, read: first?.read ?? null, shown: first?.shown ?? null }));
    assert.deepEqual(second?.shown, markAt(lines, 2, TAB));
    assert.equal(second?.read, null, 'the cut line stays unread');
    const third = injectionOf(input({ lines, read: first?.read ?? null, shown: second?.shown ?? null }));
    assert.deepEqual(third?.text.split('\n').slice(1), [`- 2030-01-07 01:00 UTC lead: item 2`]);
    assert.equal(third?.read, null, 'a whole line after the cut one stays unread with it');
  });

  it('reads the lines an earlier prompt showed whole, with the new ones', () => {
    const injection = injectionOf(input({ lines: LINES, read: markAt(LINES, 1, null), shown: markAt(LINES, 4, TAB) }));
    assert.deepEqual(injection?.text.split('\n').slice(1), SHOWN_LINES.slice(4));
    assert.deepEqual(injection?.read, markAt(LINES, 8, TAB));
  });

  it("shows each line's time on the team's clock", () => {
    assert.deepEqual(injectionOf(input({ zone: JERUSALEM }))?.text.split('\n').slice(1), [
      '- 2030-01-07 02:00 IST lead: item 1',
      '- 2030-01-07 03:00 IST lead: item 2',
      '- 2030-01-07 04:00 IST lead: item 3',
    ]);
  });

  it('shows nothing when nothing is new', () => {
    assert.equal(injectionOf(input({ read: markAt(LINES, 3, null) })), undefined);
    assert.equal(injectionOf(input({ lines: [] })), undefined);
  });
});

describe('injectFor', () => {
  function deps(files: MemoryFiles | FaultyFiles): InboxDeps {
    return { inboxes: new InboxDir(files, DIR), marks: new JsonlMarkLog(new PlainLogFile(files, MARKS)), shown: new JsonlMarkLog(new PlainLogFile(files, SHOWN)) };
  }
  const request = { area: 'alpha', claudeSession: TAB, now: NOW, zone: TimeZone.UTC, command: 'teamrig' };

  it('shows each line once, and marks read the lines it showed whole', async () => {
    const files = new MemoryFiles({ [`${DIR}/alpha.md`]: LINES.slice(0, 2).join('\n') });
    assert.match((await injectFor(deps(files), request)) ?? '', /item 1\n.*item 2$/);
    assert.equal(await injectFor(deps(files), request), undefined);
    assert.equal(await injectFor(deps(files), { ...request, claudeSession: OTHER_TAB }), undefined, 'a line read is new to no tab');
    assert.deepEqual((await deps(files).marks.read()).marks, [markAt(LINES, 2, TAB)]);
    assert.equal(files.get(SHOWN)?.trim().split('\n').length, 1);
    await deps(files).inboxes.append('alpha', LINES[2] ?? '');
    assert.equal((await injectFor(deps(files), request))?.split('\n').slice(1).join('\n'), SHOWN_LINES[2]);
  });

  it('keeps a cut line unread, so inbox read prints it whole', async () => {
    const long = `- 2030-01-07 09:00 lead: ${'x'.repeat(INJECT_CAPS.maxChars)}`;
    const files = new MemoryFiles({ [`${DIR}/alpha.md`]: long });
    assert.match((await injectFor(deps(files), request)) ?? '', /was cut at/);
    assert.equal(files.get(MARKS), undefined);
    assert.equal(files.get(SHOWN)?.trim().split('\n').length, 1);
  });

  it('still shows the lines when the read mark cannot be recorded, saying they stay unread', async () => {
    const memory = new MemoryFiles({ [`${DIR}/alpha.md`]: LINES[0] ?? '' });
    const files = new FaultyFiles(memory).fail('append', MARKS, systemError('EACCES'));
    const text = (await injectFor(deps(files), request))?.split('\n') ?? [];
    assert.deepEqual(text.slice(1, 2), SHOWN_LINES.slice(0, 1));
    assert.match(text[2] ?? '', /^They stay unread, as teamrig could not mark them read \(.*EACCES.*\); `teamrig inbox read --session alpha` does\.$/);
    assert.equal(memory.get(SHOWN)?.trim().split('\n').length, 1, 'recorded as shown, so not shown again');
  });

  it('shows nothing for an area with no inbox', async () => {
    assert.equal(await injectFor(deps(new MemoryFiles()), request), undefined);
  });

  it('throws, showing nothing, when the shown mark cannot be recorded', async () => {
    const memory = new MemoryFiles({ [`${DIR}/alpha.md`]: LINES[0] ?? '' });
    const files = new FaultyFiles(memory).fail('append', SHOWN, systemError('EACCES'));
    await assert.rejects(injectFor(deps(files), request), /EACCES/);
  });
});

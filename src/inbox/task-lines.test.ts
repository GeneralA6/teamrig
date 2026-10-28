import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { InboxDir } from './store.ts';
import { formatTaskLines, taskLinesOf } from './task-lines.ts';

const DIR = 'state/inbox';
const CORRECTION = '- 2030-01-07 09:00 po: T954 correction: keep the candles route (1d)';

async function inboxes(byArea: Record<string, readonly string[]>): Promise<InboxDir> {
  const files = new MemoryFiles();
  const dir = new InboxDir(files, DIR);
  for (const [area, lines] of Object.entries(byArea)) {
    for (const line of lines) {
      await dir.append(area, line);
    }
  }
  return dir;
}

describe('taskLinesOf', () => {
  it('finds the lines that name the task in every inbox, in the order posted, each once with its receivers', async () => {
    const dir = await inboxes({
      api: ['- 2030-01-07 10:00 lead: T954 and T12 move to next week', CORRECTION, '- 2030-01-07 11:00 po: T955 is yours'],
      lead: [CORRECTION],
      web: ['- 2030-01-06 08:00 po: task:T954 needs the route'],
    });
    assert.deepEqual(await taskLinesOf(dir, 'T954'), [
      { line: '- 2030-01-06 08:00 po: task:T954 needs the route', to: ['web'] },
      { line: CORRECTION, to: ['api', 'lead'] },
      { line: '- 2030-01-07 10:00 lead: T954 and T12 move to next week', to: ['api'] },
    ]);
  });

  it('skips a longer id and another team task of the same number', async () => {
    const dir = await inboxes({ api: ['- 2030-01-07 10:00 lead: T9540 is done', '- 2030-01-07 10:01 lead: web/T954 is done', '- 2030-01-07 10:02 lead: T95 too'] });
    assert.deepEqual(await taskLinesOf(dir, 'T954'), []);
  });

  it('finds nothing for a string that is no task id, nor in a team with no inbox', async () => {
    const dir = await inboxes({ api: ['- 2030-01-07 10:00 lead: .* everything'] });
    assert.deepEqual(await taskLinesOf(dir, '.*'), []);
    assert.deepEqual(await taskLinesOf(await inboxes({}), 'T1'), []);
  });
});

describe('formatTaskLines', () => {
  it("prints each line on the team's clock with who got it, and nothing when none names the task", () => {
    assert.deepEqual(formatTaskLines('T954', [{ line: CORRECTION, to: ['api', 'lead'] }], JERUSALEM), [
      'inbox lines naming T954 (1):',
      '  - 2030-01-07 11:00 IST po: T954 correction: keep the candles route (1d) (to api, lead)',
    ]);
    assert.deepEqual(formatTaskLines('T954', [], JERUSALEM), []);
  });
});

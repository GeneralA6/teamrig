import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from '../config/defaults.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { readWork, workWeights } from './work.ts';

const { priorities } = DEFAULT_REGISTER;

describe('workWeights', () => {
  it('sums the open and in-progress tasks of each owner, weighed by priority', () => {
    const weights = workWeights(
      [
        { owner: 'alpha', status: 'open', priority: 1 },
        { owner: 'alpha', status: 'in-progress', priority: 3 },
        { owner: 'alpha', status: 'done', priority: 1 },
        { owner: 'bravo', status: 'waiting', priority: 1 },
        { owner: 'bravo', status: 'verifying', priority: 2 },
        { owner: 'charlie', status: 'open', priority: 5 },
        { owner: 'charlie', status: 'open', priority: 9 },
      ],
      priorities,
    );
    // p1..p5 weigh 5..1; an unlisted priority weighs 1.
    assert.deepEqual([...weights], [['alpha', 8], ['charlie', 2]]);
  });

  it('ranks the priorities by id whatever their order in the config', () => {
    const weights = workWeights([{ owner: 'alpha', status: 'open', priority: 2 }], [{ id: 3, name: 'c' }, { id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    assert.equal(weights.get('alpha'), 2);
  });
});

describe('readWork', () => {
  const PATH = '/kit/teams/app/state/events.jsonl';

  it('is empty for a missing register', async () => {
    assert.deepEqual([...(await readWork(new MemoryFiles(), PATH, priorities))], []);
  });

  it('is empty when the register cannot be read, so the split falls back to shares', async () => {
    const files = new FaultyFiles(new MemoryFiles({ [PATH]: '' })).fail('read', PATH, systemError('EIO'));
    assert.deepEqual([...(await readWork(files, PATH, priorities))], []);
  });
});

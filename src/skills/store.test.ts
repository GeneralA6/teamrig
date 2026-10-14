import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { SkillDir } from './store.ts';

const DIR = 'home/skills';

describe('SkillDir', () => {
  const files = new MemoryFiles({
    [`${DIR}/bravo-deploy/SKILL.md`]: 'b',
    [`${DIR}/alpha-review/SKILL.md`]: 'a',
    [`${DIR}/alpha-review/helper.ts`]: 'x',
    [`${DIR}/cache/index.json`]: '{}',
    [`${DIR}/Bad_Name/SKILL.md`]: 'z',
    'home/outside/SKILL.md': 'o',
  });
  const skills = new SkillDir(files, DIR);

  it('reads every folder with a SKILL.md, in name order', async () => {
    assert.deepEqual(await skills.readAll(), [
      { name: 'alpha-review', text: 'a' },
      { name: 'bravo-deploy', text: 'b' },
    ]);
  });

  it('knows which skills exist and never looks outside the folder', async () => {
    assert.equal(await skills.exists('alpha-review'), true);
    assert.equal(await skills.exists('cache'), false);
    assert.equal(await skills.exists('../outside'), false);
    assert.equal(skills.pathOf('alpha-review'), `${DIR}/alpha-review/SKILL.md`);
  });
});

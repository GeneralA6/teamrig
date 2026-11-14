import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { grantGaps } from './grants.ts';
import type { SkillFile } from './lint.ts';
import { MAX_FOLLOWED, runScriptPaths, skillsToLint, withRunScripts } from './run-scripts.ts';

const HOME = 'D:/devhome';
const FOLDER = 'D:/devhome/skills/ship-it';

/** MemoryFiles that also records every path read through `readHead`. */
class WatchedFiles extends MemoryFiles {
  readonly heads: string[] = [];

  override async readHead(path: string, maxBytes: number): Promise<string | undefined> {
    this.heads.push(path);
    return super.readHead(path, maxBytes);
  }
}

function skill(text: string, scripts: SkillFile['scripts'] = []): SkillFile {
  return { name: 'ship-it', text, scripts };
}

describe('runScriptPaths', () => {
  it('reads each rooted script path a line runs: through an interpreter, a call operator, -File, or as the command', () => {
    const text = [
      '1. `node --disable-warning=ExperimentalWarning C:/Work/kit/.ship/tools/ship/ship.ts "$W" plan.json --merge`',
      'npx tsx ~/tools/a.mts --dry-run',
      `& "C:\\Program Files\\kit\\run.ps1" -Check`,
      'pwsh -NoProfile -File $HOME/tools/b.ps1',
      '~/tools/c.sh --go',
      '$ /opt/kit/d.sh',
      'python C:\\Work\\x\\..\\y.py',
      'again: node C:/Work/kit/.ship/tools/ship/ship.ts',
    ].join('\n');
    assert.deepEqual(runScriptPaths(text, HOME), [
      'C:/Work/kit/.ship/tools/ship/ship.ts',
      'D:/devhome/tools/a.mts',
      'C:/Program Files/kit/run.ps1',
      'D:/devhome/tools/b.ps1',
      'D:/devhome/tools/c.sh',
      '/opt/kit/d.sh',
      'C:/Work/y.py',
    ]);
  });

  it('leaves out a path nothing runs, a URL, a relative path, a file that is no script, and a UNC or device path', () => {
    const text = [
      'See C:/Work/kit/notes.ts for why.',
      'node https://example.com/a.js',
      'node tools/ship/ship.ts',
      'node C:/Work/kit/README.md',
      'node C:/Work/kit/a.ts.bak',
      'node //host/share/x.ts',
      'node \\\\host\\share\\x.ts',
      'node "\\\\?\\C:\\Work\\x.ts"',
    ].join('\n');
    assert.deepEqual(runScriptPaths(text, HOME), []);
  });
});

describe('withRunScripts', () => {
  it('reads the scripts a SKILL.md runs and every module they import by a relative path, once each', async () => {
    const files = new MemoryFiles({
      'C:/Work/kit/tools/ship/ship.ts': [
        "import { readFileSync } from 'node:fs';",
        "import { tokenOf } from './keychain.ts';",
        "export { DIST } from '../../src/core/files.js';",
        "const lazy = await import('./lazy');",
        "const old = require('./old.cjs');",
        "import './missing.ts';",
      ].join('\n'),
      'C:/Work/kit/tools/ship/keychain.ts': "import { DIST } from './ship.ts';\nconst read = 'CredReadW';",
      'C:/Work/kit/src/core/files.ts': 'export const DIST = 1;',
      'C:/Work/kit/tools/ship/lazy.ts': 'export {};',
      'C:/Work/kit/tools/ship/old.cjs': 'module.exports = {};',
    });
    const read = await withRunScripts(files, skill('Run `node C:/Work/kit/tools/ship/ship.ts "$W"`.'), FOLDER, HOME);
    assert.deepEqual(
      read.scripts.map((script) => script.name),
      ['C:/Work/kit/tools/ship/ship.ts', 'C:/Work/kit/tools/ship/keychain.ts', 'C:/Work/kit/src/core/files.ts', 'C:/Work/kit/tools/ship/lazy.ts', 'C:/Work/kit/tools/ship/old.cjs'],
    );
    assert.deepEqual(grantGaps(read.text, read.scripts), [
      'secret-read in C:/Work/kit/tools/ship/keychain.ts, which auto mode does not see: with the owner\'s grant add "Grants: secret-read", else drop the call',
    ]);
  });

  it("follows the folder's own scripts' imports, naming each from the folder, and a home script from ~", async () => {
    const files = new MemoryFiles({
      [`${FOLDER}/lib/auth.ts`]: "const header = { Authorization: 'Bearer ' + t };",
      'D:/devhome/tools/x.mts': 'export {};',
    });
    const own = { name: 'helper.ts', text: "import { header } from './lib/auth.ts';" };
    const read = await withRunScripts(files, skill('node ~/tools/x.mts', [own]), FOLDER, HOME);
    assert.deepEqual(read.scripts.map((script) => script.name), ['helper.ts', '~/tools/x.mts', 'lib/auth.ts']);
  });

  it(`stops at ${MAX_FOLLOWED} followed scripts, so a script that imports a whole program stays a bounded read`, async () => {
    const chain: Record<string, string> = {};
    for (let n = 0; n < MAX_FOLLOWED + 5; n++) {
      chain[`C:/Work/chain/m${n}.ts`] = `import './m${n + 1}.ts';`;
    }
    const read = await withRunScripts(new MemoryFiles(chain), skill('node C:/Work/chain/m0.ts'), FOLDER, HOME);
    assert.equal(read.scripts.length, MAX_FOLLOWED);
  });

  it('skips a named script it may not read, and still fails on an error no path explains', async () => {
    const inner = new MemoryFiles({ 'C:/Work/kit/b.ts': 'export {};' });
    const files = new FaultyFiles(inner).fail('readHead', 'C:/Work/kit/a.ts', systemError('EACCES'));
    const read = await withRunScripts(files, skill('node C:/Work/kit/a.ts\nnode C:/Work/kit/b.ts'), FOLDER, HOME);
    assert.deepEqual(read.scripts.map((script) => script.name), ['C:/Work/kit/b.ts']);
    files.fail('readHead', 'C:/Work/kit/b.ts', systemError('EIO'));
    await assert.rejects(withRunScripts(files, skill('node C:/Work/kit/b.ts'), FOLDER, HOME), /EIO: simulated/);
  });

  it('never reads a UNC path, and gives back a skill with nothing to follow as it was', async () => {
    const files = new WatchedFiles({});
    const plain = skill('node //host/share/x.ts\nRun it by hand.', [{ name: 'a.sh', text: 'echo hi' }]);
    assert.equal(await withRunScripts(files, plain, FOLDER, HOME), plain);
    assert.deepEqual(files.heads, []);
  });
});

describe('skillsToLint', () => {
  it('reads every skill in the folder with the scripts it runs from outside it', async () => {
    const files = new MemoryFiles({
      'D:/devhome/skills/ship-it/SKILL.md': 'node ~/tools/ship.ts',
      'D:/devhome/skills/plain/SKILL.md': 'No scripts.',
      'D:/devhome/tools/ship.ts': 'gh auth token',
    });
    const skills = await skillsToLint(files, 'D:/devhome/skills', HOME);
    assert.deepEqual(
      skills.map((each) => [each.name, each.scripts.map((script) => script.name)]),
      [
        ['plain', []],
        ['ship-it', ['~/tools/ship.ts']],
      ],
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeMergeGit } from '../testing/fake-merge-git.ts';
import { relativeImportsOf, TOOL_CODE_MAX_FILES, toolCodeAt } from './ship-role-check.ts';

describe('relativeImportsOf reads the files a module loads beside it (T3419)', () => {
  it('reads static, type, side-effect and dynamic imports, a re-export and a URL read beside it, as repository paths', () => {
    const text = [
      "import { a } from './a.ts';",
      "import type { B } from '../src/b.ts';",
      "import './side.ts';",
      "export { c } from './nested/c.ts';",
      "const d = await import('./d.ts');",
      "const PROFILES = new URL('./repos.json', import.meta.url);",
    ].join('\n');
    assert.deepEqual(relativeImportsOf(text, 'tools/ship/ship.ts'), ['tools/ship/a.ts', 'tools/src/b.ts', 'tools/ship/side.ts', 'tools/ship/nested/c.ts', 'tools/ship/d.ts', 'tools/ship/repos.json']);
  });

  it("reads no package or built-in import, and leaves a path out of the checkout as `../`", () => {
    const text = "import { join } from 'node:path';\nimport ts from 'typescript';\nimport { x } from '../../../x.ts';\n";
    assert.deepEqual(relativeImportsOf(text, 'tools/ship/ship.ts'), ['../x.ts']);
  });
});

describe('toolCodeAt reads the code a ship tool runs at a commit (T3419)', () => {
  /** A fake git whose commit `c` holds each of `files`, by path. */
  function gitWith(files: Readonly<Record<string, string>>): FakeMergeGit {
    const git = new FakeMergeGit();
    for (const [path, text] of Object.entries(files)) {
      git.files.set(`c:${path}`, text);
    }
    return git;
  }

  it('follows the imports through a cycle to every file, sorted, each once', () => {
    const git = gitWith({
      'tools/ship/ship.ts': "import { a } from './a.ts';\nimport { h } from '../../src/core/home.ts';\n",
      'tools/ship/a.ts': "import { s } from './ship.ts';\n",
      'src/core/home.ts': "import { join } from 'node:path';\n",
    });
    assert.deepEqual(toolCodeAt(git, '/repo', 'c', 'tools/ship/ship.ts'), ['src/core/home.ts', 'tools/ship/a.ts', 'tools/ship/ship.ts']);
  });

  it('tells nothing when a file is not at the commit, one leaves the checkout, or the code passes its file limit', () => {
    const missing = gitWith({ 'tools/ship/ship.ts': "import { a } from './a.ts';\n" });
    const outside = gitWith({ 'tools/ship/ship.ts': "import { x } from '../../../x.ts';\n" });
    const files: Record<string, string> = {};
    for (let n = 0; n <= TOOL_CODE_MAX_FILES; n += 1) {
      files[`tools/ship/m${n}.ts`] = `import { m } from './m${n + 1}.ts';\n`;
    }
    const huge = gitWith(files);
    for (const [name, git, tool] of [['missing', missing, 'tools/ship/ship.ts'], ['outside', outside, 'tools/ship/ship.ts'], ['huge', huge, 'tools/ship/m0.ts']] as const) {
      assert.equal(toolCodeAt(git, '/repo', 'c', tool), undefined, name);
    }
  });
});

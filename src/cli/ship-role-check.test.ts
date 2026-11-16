import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GIT_MERGE } from '../merge/git.ts';
import { FakeMergeGit } from '../testing/fake-merge-git.ts';
import { relativeImportsOf, TOOL_CODE_MAX_FILES, toolCodeAt, toolRootsOf, toolRootsPath } from './ship-role-check.ts';

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

  it('reads no import a doc comment or a string only names, and tells nothing of code it cannot read apart from text', () => {
    const text = "/** Runs a script: `import … from './x'` in its text. */\nconst shown = \"from './y.ts'\";\nimport { z } from './z.ts';\n";
    assert.deepEqual(relativeImportsOf(text, 'src/skills/run-scripts.ts'), ['src/skills/z.ts']);
    assert.equal(relativeImportsOf("/* open\nimport './a.ts';", 'src/a.ts'), undefined);
  });
});

describe('toolRootsOf reads the files a ship tool runs beside its imports, as data (T3419)', () => {
  it("names the roots file beside the tool, and reads its roots as paths in the checkout", () => {
    assert.deepEqual([toolRootsPath('tools/ship/ship.ts'), toolRootsPath('bin/ship')], ['tools/ship/ship.roots.json', 'bin/ship.roots.json']);
    assert.deepEqual(toolRootsOf('{"roots": ["src/cli/main.ts", "./package.json"]}'), ['src/cli/main.ts', 'package.json']);
  });

  it('tells nothing of a file that is no JSON of that shape, or a root that is absolute or leaves the checkout', () => {
    for (const text of ['not json', '[]', '{"roots": "main.ts"}', '{"roots": [1]}', '{"roots": ["../x.ts"]}', '{"roots": ["/x.ts"]}', '{"roots": ["C:/x.ts"]}', '{"roots": ["."]}']) {
      assert.equal(toolRootsOf(text), undefined, text);
    }
  });
});

describe('toolCodeAt reads the code a ship tool runs at a commit (T3419)', () => {
  /** A fake git whose commit `c` holds each of `files`, by path, and no other file. */
  function gitWith(files: Readonly<Record<string, string>>): FakeMergeGit {
    const git = new FakeMergeGit();
    for (const [path, text] of Object.entries(files)) {
      git.files.set(`c:${path}`, text);
    }
    git.blobs.set('c:tools/ship/ship.roots.json', files['tools/ship/ship.roots.json'] === undefined ? undefined : 'roots-blob');
    return git;
  }

  it('follows the imports through a cycle to every file, sorted, each once, with the path of the roots file it lacks', () => {
    const git = gitWith({
      'tools/ship/ship.ts': "import { a } from './a.ts';\nimport { h } from '../../src/core/home.ts';\n",
      'tools/ship/a.ts': "import { s } from './ship.ts';\n",
      'src/core/home.ts': "import { join } from 'node:path';\n",
    });
    assert.deepEqual(toolCodeAt(git, '/repo', 'c', 'tools/ship/ship.ts'), ['src/core/home.ts', 'tools/ship/a.ts', 'tools/ship/ship.roots.json', 'tools/ship/ship.ts']);
  });

  it('follows the imports of each root its roots file names, and reads a data root without following it', () => {
    const git = gitWith({
      'tools/ship/ship.ts': "export {};\n",
      'tools/ship/ship.roots.json': '{"roots": ["src/cli/main.ts", "package.json"]}',
      'src/cli/main.ts': "import './run.ts';\n",
      'src/cli/run.ts': "export {};\n",
      'package.json': '{"from": "./nowhere.ts"}',
    });
    assert.deepEqual(toolCodeAt(git, '/repo', 'c', 'tools/ship/ship.ts'), ['package.json', 'src/cli/main.ts', 'src/cli/run.ts', 'tools/ship/ship.roots.json', 'tools/ship/ship.ts']);
  });

  it('tells nothing when a file is not at the commit, one leaves the checkout, the code passes its file limit, or the roots cannot be read', () => {
    const missing = gitWith({ 'tools/ship/ship.ts': "import { a } from './a.ts';\n" });
    const outside = gitWith({ 'tools/ship/ship.ts': "import { x } from '../../../x.ts';\n" });
    const unread = gitWith({ 'tools/ship/ship.ts': "export {};\n" });
    unread.unreadable.add('c');
    const badRoots = gitWith({ 'tools/ship/ship.ts': "export {};\n", 'tools/ship/ship.roots.json': '{"roots": ["../x.ts"]}' });
    const missingRoot = gitWith({ 'tools/ship/ship.ts': "export {};\n", 'tools/ship/ship.roots.json': '{"roots": ["src/cli/main.ts"]}' });
    const files: Record<string, string> = {};
    for (let n = 0; n <= TOOL_CODE_MAX_FILES; n += 1) {
      files[`tools/ship/m${n}.ts`] = `import { m } from './m${n + 1}.ts';\n`;
    }
    const huge = gitWith(files);
    const cases = { missing, outside, unread, badRoots, missingRoot };
    for (const [name, git] of Object.entries(cases)) {
      assert.equal(toolCodeAt(git, '/repo', 'c', 'tools/ship/ship.ts'), undefined, name);
    }
    assert.equal(toolCodeAt(huge, '/repo', 'c', 'tools/ship/m0.ts'), undefined, 'huge');
  });

  it("reads the whole code this repository's own ship tool runs at HEAD, the CLI it spawns and the package files included", () => {
    const top = join(import.meta.dirname, '..', '..');
    const code = toolCodeAt(GIT_MERGE, top, 'HEAD', 'tools/ship/ship.ts');
    assert.ok(code !== undefined, 'the closure is defined at HEAD');
    for (const file of ['tools/ship/ship.roots.json', 'tools/ship/repos.json', 'tools/ship/merge.ts', 'src/cli/main.ts', 'src/cli/run.ts', 'package.json', 'package-lock.json']) {
      assert.ok(code.includes(file), file);
    }
  });
});

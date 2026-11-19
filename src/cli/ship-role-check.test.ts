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
    assert.deepEqual(toolRootsOf('{"roots": ["src/cli/main.ts", "./package.json"]}'), { roots: ['src/cli/main.ts', 'package.json'], staticOnly: [] });
  });

  it('reads the modules whose import() calls are not followed, as paths in the checkout (#1686)', () => {
    assert.deepEqual(toolRootsOf('{"roots": ["src/cli/main.ts"], "staticOnly": ["./src/cli/run.ts"]}'), { roots: ['src/cli/main.ts'], staticOnly: ['src/cli/run.ts'] });
  });

  it('tells nothing of a file that is no JSON of that shape, or a path that is absolute or leaves the checkout', () => {
    const bad = ['not json', '[]', '{"roots": "main.ts"}', '{"roots": [1]}', '{"roots": ["../x.ts"]}', '{"roots": ["/x.ts"]}', '{"roots": ["C:/x.ts"]}', '{"roots": ["."]}'];
    const badStaticOnly = ['{"roots": [], "staticOnly": "x.ts"}', '{"roots": [], "staticOnly": [1]}', '{"roots": [], "staticOnly": ["../x.ts"]}', '{"roots": [], "staticOnly": ["/x.ts"]}'];
    for (const text of [...bad, ...badStaticOnly]) {
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
    return git;
  }

  it('reads each level of imports in one git read, never one read per file (T4035)', () => {
    const git = gitWith({
      'tools/ship/ship.ts': "import './a.ts';\nimport './b.ts';\nimport './c.ts';\n",
      'tools/ship/a.ts': "import './d.ts';\nimport './b.ts';\n",
      'tools/ship/b.ts': "import './d.ts';\n",
      'tools/ship/c.ts': "import './ship.ts';\n",
      'tools/ship/d.ts': "export {};\n",
    });
    assert.deepEqual(toolCodeAt(git, '/repo', 'c', 'tools/ship/ship.ts'), ['tools/ship/a.ts', 'tools/ship/b.ts', 'tools/ship/c.ts', 'tools/ship/d.ts', 'tools/ship/ship.roots.json', 'tools/ship/ship.ts']);
    assert.deepEqual(git.fileReads, [1, 1, 3, 1], 'the roots file, the tool, its three imports, then d once');
  });

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

  it("follows no import() of a staticOnly module, only its static imports and the commands named as roots (#1686)", () => {
    const git = gitWith({
      'tools/ship/ship.ts': "export {};\n",
      'tools/ship/ship.roots.json': '{"roots": ["src/cli/main.ts", "src/cli/commands/step.ts"], "staticOnly": ["src/cli/run.ts"]}',
      'src/cli/main.ts': "import './run.ts';\n",
      'src/cli/run.ts': "import './args.ts';\nconst table = { step: () => import('./commands/step.ts'), queue: () => import('./commands/queue.ts') };\n",
      'src/cli/args.ts': "export {};\n",
      'src/cli/commands/step.ts': "const lazy = () => import('../locks.ts');\n",
      'src/cli/locks.ts': "export {};\n",
      'src/cli/commands/queue.ts': "export {};\n",
    });
    assert.deepEqual(toolCodeAt(git, '/repo', 'c', 'tools/ship/ship.ts'), [
      'src/cli/args.ts',
      'src/cli/commands/step.ts',
      'src/cli/locks.ts',
      'src/cli/main.ts',
      'src/cli/run.ts',
      'tools/ship/ship.roots.json',
      'tools/ship/ship.ts',
    ]);
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

  it("reads the whole code this repository's own ship tool runs at HEAD, the CLI commands it spawns and the package files included", () => {
    const top = join(import.meta.dirname, '..', '..');
    const code = toolCodeAt(GIT_MERGE, top, 'HEAD', 'tools/ship/ship.ts');
    assert.ok(code !== undefined, 'the closure is defined at HEAD');
    const runs = ['tools/ship/ship.roots.json', 'tools/ship/repos.json', 'tools/ship/merge.ts', 'src/cli/main.ts', 'src/cli/run.ts', 'src/cli/commands/step-aside.ts', 'package.json', 'package-lock.json'];
    for (const file of runs) {
      assert.ok(code.includes(file), file);
    }
    // #1686: the ship runs only step-away and step-back, so another command's module is no code of its tool.
    for (const file of ['src/cli/commands/issue-push.ts', 'src/cli/commands/hook-meeting-panel.ts']) {
      assert.ok(!code.includes(file), file);
    }
  });

  it('holds every module run.ts loads by import() outside a command entry, which runs before any command the ship spawns (#1686)', () => {
    const top = join(import.meta.dirname, '..', '..');
    const code = toolCodeAt(GIT_MERGE, top, 'HEAD', 'tools/ship/ship.ts') ?? [];
    const run = GIT_MERGE.filesAt(top, 'HEAD', ['src/cli/run.ts'])?.get('src/cli/run.ts') ?? '';
    const loaders = [...run.matchAll(/const (\w+) = \(\) => import\('(\.\/[^']+)'\);/g)];
    assert.ok(loaders.length > 0, "run.ts's command table");
    // run.ts is staticOnly in the roots file: a loader called anywhere but a command's own `load` (such as the tab check
    // runCli does before every write command) runs for step-away and step-back too, so its module must be a root.
    const preamble = loaders.filter(([, name]) => {
      const calls = run.match(new RegExp(`\\b${name}\\(\\)`, 'g'))?.length ?? 0;
      const loads = run.match(new RegExp(`load: async \\(\\) =>\\s*\\(await ${name}\\(\\)\\)`, 'g'))?.length ?? 0;
      return calls > loads;
    });
    assert.ok(preamble.length > 0, 'the tab check before a write command');
    for (const [, , specifier = ''] of preamble) {
      const file = `src/cli/${specifier.slice('./'.length)}`;
      assert.ok(code.includes(file), file);
    }
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moduleSpecifiersOf } from './module-specifiers.ts';

describe('moduleSpecifiersOf reads the specifiers a module loads, from its code only (T3419)', () => {
  it('reads static, type, side-effect and dynamic imports, a re-export, a multi-line import and a URL read beside it', () => {
    const text = [
      "import { a } from './a.ts';",
      "import type { B } from '../src/b.ts';",
      "import './side.ts';",
      "export { c } from './nested/c.ts';",
      'import {',
      '  e,',
      "} from \"./e.ts\";",
      "const d = await import('./d.ts');",
      'const t = await import(`./t.ts`);',
      "const PROFILES = new URL('./repos.json', import.meta.url);",
    ].join('\n');
    assert.deepEqual(moduleSpecifiersOf(text), ['./a.ts', '../src/b.ts', './side.ts', './nested/c.ts', './e.ts', './d.ts', './t.ts', './repos.json']);
  });

  it('leaves out only the dynamic imports with dynamic false, as a module loaded when its caller runs (#1686)', () => {
    const text = [
      "import { a } from './a.ts';",
      "import './side.ts';",
      "export { c } from './c.ts';",
      "const d = await import('./d.ts');",
      "const table = { queue: () => import('./commands/queue.ts') };",
      "const PROFILES = new URL('./repos.json', import.meta.url);",
    ].join('\n');
    assert.deepEqual(moduleSpecifiersOf(text, { dynamic: false }), ['./a.ts', './side.ts', './c.ts', './repos.json']);
    assert.deepEqual(moduleSpecifiersOf(text), ['./a.ts', './side.ts', './c.ts', './d.ts', './commands/queue.ts', './repos.json']);
  });

  it('reads nothing from a comment, a string, a template or a regular expression that only names an import', () => {
    const text = [
      "/** A module's imports: `import … from './x'`, `import('./y')`. */",
      "// import { z } from './z.ts';",
      "const doc = \"import { w } from './w.ts'\";",
      "const shown = `from './v.ts'`;",
      "const pattern = /from\\s*['\"](\\.\\/[^'\"]+)['\"]/g;",
      "const half = 4 / 2; const quarter = half / 2;",
      "import { real } from './real.ts';",
    ].join('\n');
    assert.deepEqual(moduleSpecifiersOf(text), ['./real.ts']);
  });

  it('reads an import after a template whose code holds braces and strings, and none built at run time', () => {
    const text = [
      "const line = `${items.map((item) => { return `${item}'`; }).join('}')} done`;",
      'const built = new URL(`./main${extension}`, import.meta.url);',
      "import { after } from './after.ts';",
    ].join('\n');
    assert.deepEqual(moduleSpecifiersOf(text), ['./after.ts']);
  });

  it('steps over a #! line, and tells nothing when a comment, string, template or regular expression does not end', () => {
    assert.deepEqual(moduleSpecifiersOf("#!/usr/bin/env node\nimport './cli.ts';\n"), ['./cli.ts']);
    for (const text of ["/* open\nimport './a.ts';", "const s = 'open\nimport './a.ts';", 'const t = `open', 'const r = /open\n']) {
      assert.equal(moduleSpecifiersOf(text), undefined, text);
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { importClosure } from './import-closure.ts';

describe('importClosure', () => {
  it('catches an outside import wherever it hides, the dynamic and re-exported ones too', () => {
    const root = resolve('/x');
    const files = new Map([
      [resolve(root, 'entry.ts'), "export { a } from './a.ts';\n// import 'node:comment';\n"],
      [resolve(root, 'a.ts'), "export * from 'node:fs';\nimport type { B } from './b.ts';\nexport const a = 'import \"node:string\"';\n"],
      [resolve(root, 'b.ts'), "import './a.ts';\nexport const b = await import('node:path');\nimport {\n  c,\n} from 'some-package';\n"],
    ]);
    const closure = importClosure(resolve(root, 'entry.ts'), root, (file) => files.get(file) ?? '');
    assert.deepEqual(closure.outside, ['a.ts imports node:fs', 'b.ts imports node:path', 'b.ts imports some-package']);
    assert.deepEqual(closure.files, ['a.ts', 'b.ts', 'entry.ts']);
  });
});

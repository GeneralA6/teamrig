import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as read from './index.ts';

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const SRC = dirname(dirname(ENTRY));

interface ImportClosure {
  /** Every file reached, relative to `root`, with forward slashes. */
  readonly files: readonly string[];
  /** Each import of something that is not a relative file: `node:` modules and packages alike. */
  readonly outside: readonly string[];
}

/**
 * Follows every import from `entry` (static, `import type`, `export ... from`, side-effect and
 * dynamic), the way TypeScript itself finds them, so comments and strings never count.
 */
function importClosure(entry: string, root: string, readText: (file: string) => string): ImportClosure {
  const seen = new Set<string>();
  const outside: string[] = [];
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const { fileName } of ts.preProcessFile(readText(file), true, true).importedFiles) {
      if (fileName.startsWith('./') || fileName.startsWith('../')) {
        queue.push(resolve(dirname(file), fileName));
      } else {
        outside.push(`${relative(root, file).replaceAll('\\', '/')} imports ${fileName}`);
      }
    }
  }
  return { files: [...seen].map((file) => relative(root, file).replaceAll('\\', '/')).sort(), outside };
}

describe('the read entry', () => {
  it('reaches no node: module and no package, so a reader without Node built-ins can run it', () => {
    const closure = importClosure(ENTRY, SRC, (file) => readFileSync(file, 'utf8'));
    assert.deepEqual(closure.outside, []);
    for (const file of ['register/events.ts', 'register/fold.ts', 'inbox/unread.ts', 'config/parse.ts']) {
      assert.ok(closure.files.includes(file), `${file} is part of the read side`);
    }
    assert.ok(!closure.files.some((file) => file.endsWith('.test.ts')), 'no test file is reachable');
  });

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

  it('shows no line from a newer teamrig and counts it as teamrig list warns', () => {
    const create = (id: string, version: number): string =>
      JSON.stringify({ v: version, type: 'create', id, at: '2030-01-07T09:00:00.000Z', by: 'lead', task: { title: id, owner: 'alpha', source: 'owner', ref: null, priority: 7, due: null, goals: [], week: null } });
    const snapshot = read.readRegister([create('T1', read.EVENT_VERSION), create('T2', read.EVENT_VERSION + 1), '{torn'].join('\n'));
    assert.deepEqual([...snapshot.state.tasks.keys()], ['T1']);
    assert.deepEqual([snapshot.read.newer, snapshot.read.unreadable, snapshot.state.orphans], [1, 1, 0]);
    assert.equal(read.priorityText(snapshot.state.tasks.get('T1')?.priority ?? 0), 'p7');
  });

  it('finds the unread inbox lines with the line hash the reader hands in', () => {
    const hash: read.LineHash = (line) => `fake:${line}`;
    const lines = read.inboxLines('- 2030-01-07 09:00 lead: first\r\n- 2030-01-07 10:00 lead: second\r\n');
    const marks = read.readMarks(
      `${JSON.stringify({ v: read.MARK_VERSION, area: 'alpha', line: 1, at: '2030-01-07T09:30:00.000Z', claudeSession: null, lastLineHash: hash(lines[0] ?? '') })}\n`,
    );
    const unread = read.unreadOf('alpha', lines, read.indexMarks(marks.marks).byArea.get('alpha') ?? null, hash);
    assert.deepEqual([unread.resume, unread.lines], ['grew', ['- 2030-01-07 10:00 lead: second']]);
  });

  it('names a priority from the config text, as written by any config version', () => {
    const config = read.parseConfigText(JSON.stringify({ configVersion: 1, sessions: ['alpha'], roles: { lead: 'alpha' }, register: { tiers: [{ id: 7, name: 'someday' }] } }));
    assert.equal(config.status, 'loaded');
    if (config.status === 'loaded') {
      assert.equal(read.priorityName(config.config.register.priorities, 7), 'someday');
    }
  });
});

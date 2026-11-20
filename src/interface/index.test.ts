import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretScanner } from '../core/secrets.ts';
import { importClosure } from '../testing/import-closure.ts';
import * as api from './index.ts';

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const SRC = dirname(dirname(ENTRY));

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

describe('the public interface data', () => {
  it('reaches no node: module and no package, so a reader without Node built-ins can run it', () => {
    const closure = importClosure(ENTRY, SRC, (file) => readFileSync(file, 'utf8'));
    assert.deepEqual(closure.outside, []);
    assert.ok(closure.files.includes('interface/text.ts') && closure.files.includes('core/printable.ts'));
    assert.ok(!closure.files.some((file) => file.endsWith('.test.ts')), 'no test file is reachable');
  });

  it('reads a version only as major.minor in one spelling', () => {
    assert.deepEqual(['1.0', '2.13', '0.3'].map(api.parseInterfaceVersion), [{ major: 1, minor: 0 }, { major: 2, minor: 13 }, { major: 0, minor: 3 }]);
    assert.deepEqual(['1', '1.', '1.0.0', 'v1.0', '01.0', '1.00', ' 1.0', '-1.0', ''].map(api.parseInterfaceVersion), Array.from({ length: 9 }, () => undefined));
  });

  it('serves a reader that names no version, the served one or an older minor, and refuses another major or a newer minor', () => {
    assert.equal(api.INTERFACE_VERSION, `${api.INTERFACE_MAJOR}.${api.INTERFACE_MINOR}`);
    assert.deepEqual(api.checkInterfaceRange(undefined), { served: true });
    assert.deepEqual(api.checkInterfaceRange({ major: api.INTERFACE_MAJOR, minor: api.INTERFACE_MINOR }), { served: true });
    const newerMinor = api.checkInterfaceRange({ major: api.INTERFACE_MAJOR, minor: api.INTERFACE_MINOR + 1 });
    const newerMajor = api.checkInterfaceRange({ major: api.INTERFACE_MAJOR + 1, minor: 0 });
    const olderMajor = api.checkInterfaceRange({ major: api.INTERFACE_MAJOR - 1, minor: 9 });
    assert.deepEqual(
      [newerMinor, newerMajor, olderMajor].map((check) => (check.served ? 'served' : check.reason)),
      [
        `interface 1.1 is newer than the ${api.INTERFACE_VERSION} this teamrig serves; update teamrig`,
        `interface 2.0 is newer than the ${api.INTERFACE_VERSION} this teamrig serves; update teamrig`,
        `interface 0.9 is no longer served; this teamrig serves ${api.INTERFACE_VERSION}, so update the reader`,
      ],
    );
  });

  it('names the five documents and wraps a body in the head a body cannot replace', () => {
    assert.deepEqual(api.DOCUMENTS, ['tasks', 'inbox', 'sessions', 'meetings', 'config']);
    assert.deepEqual(['tasks', 'config', 'stats', ''].map(api.isDocumentName), [true, true, false, false]);
    const answer = api.answerOf('tasks', 'abc', ['one line'], { tasks: [], revision: 'from the body' });
    assert.deepEqual(answer, { tasks: [], interface: api.INTERFACE_VERSION, document: 'tasks', revision: 'abc', problems: ['one line'] });
    assert.deepEqual(api.unchangedAnswer('inbox', 'abc'), { interface: api.INTERFACE_VERSION, document: 'inbox', revision: 'abc', unchanged: true });
  });

  it('serves team text as written and escapes the control and bidi marks of outside text', () => {
    const served = new api.ServedText(new SecretScanner());
    const raw = 'line one\nline \u001b[31mtwo‮';
    assert.deepEqual(served.marked('T1', 'title', raw, 'team'), { text: raw, source: 'team' });
    assert.deepEqual(served.marked('T1', 'title', raw, 'outside'), { text: 'line one\\nline \\x1b[31mtwo\\u202e', source: 'outside' });
    assert.equal(served.plain('T1', 'note', raw), raw);
    assert.deepEqual([served.plainOrNull('T1', 'note', null), served.markedOrNull('T1', 'description', null, 'outside')], [null, null]);
    assert.deepEqual(served.cuts, []);
  });

  it('cuts the whole field of a text that matches a secret shape, keeping the record, the field and the shape', () => {
    const scanner = new SecretScanner();
    const shape = scanner.find(SECRET)?.description;
    assert.ok(shape !== undefined, 'the fixture matches a shipped shape');
    const served = new api.ServedText(scanner);
    const text = `the login is ${SECRET} and more words`;
    assert.equal(served.plain('T7', 'note', text), `[cut: ${shape}]`);
    assert.equal(served.plainOrNull('T7', 'proof', text), `[cut: ${shape}]`);
    assert.deepEqual(served.marked('T7', 'title', text, 'outside'), { text: `[cut: ${shape}]`, source: 'outside' });
    assert.deepEqual(served.markedOrNull('k1', 'text', text, 'team'), { text: api.cutText(shape), source: 'team' });
    assert.deepEqual(served.cuts, [
      { id: 'T7', field: 'note', shape },
      { id: 'T7', field: 'proof', shape },
      { id: 'T7', field: 'title', shape },
      { id: 'k1', field: 'text', shape },
    ]);
    assert.ok(!JSON.stringify(served.cuts).includes('hunter2'));
  });
});

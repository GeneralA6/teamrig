import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { canonicalJson, sha256Hex } from './digest.ts';
import {
  argvSha256,
  inlineCodeOption,
  parseDraft,
  programLookup,
  readStoredRequest,
  requestSha256,
  type DraftParse,
  type ExecRequest,
  type RequestDraft,
} from './request.ts';

const COMMIT = 'a'.repeat(40);
const LOCK = 'b'.repeat(64);
const IMAGE = `registry/worker@sha256:${'c'.repeat(64)}`;

/** A db-write request file as a requester writes it. */
function dbWrite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'db-write',
    task: 'T755',
    target: 'local app.items',
    argv: ['node', 'tools/fix-models.ts', '--apply'],
    cwd: 'C:/work/app',
    binding: { repo: 'C:/work/app', commit: COMMIT, lockSha256: LOCK },
    envNames: ['DB_WRITE_URI'],
    readEnvNames: ['DB_READ_URI'],
    maxRuntimeSec: 600,
    rerunSafe: true,
    purpose: 'Refill 12 rows of 3 items',
    expected: 'inserted 12, changed 0, unchanged 4,000',
    dryRunArgv: ['node', 'tools/fix-models.ts'],
    preview: null,
    rollback: 'tools/fix-models.ts --undo <run id>',
    window: null,
    ownerGated: false,
    ...overrides,
  };
}

const scanner = new SecretScanner();

function draftOf(parse: DraftParse): RequestDraft {
  assert.ok(parse.ok, parse.ok ? '' : parse.problems.join('; '));
  return parse.draft;
}

function problemsOf(parse: DraftParse): readonly string[] {
  assert.equal(parse.ok, false, 'expected a refusal');
  return parse.ok ? [] : parse.problems;
}

function request(draft: RequestDraft): ExecRequest {
  return { ...draft, id: 'R1', requester: 'alpha', createdAt: '2030-01-07T10:00:00.000Z', program: 'C:/nodejs/node.exe', dryRunProgram: 'C:/nodejs/node.exe' };
}

describe('parseDraft (T755)', () => {
  it('reads a complete db-write request', () => {
    const draft = draftOf(parseDraft(dbWrite(), scanner));
    assert.equal(draft.kind, 'db-write');
    assert.deepEqual(draft.argv, ['node', 'tools/fix-models.ts', '--apply']);
    assert.deepEqual(draft.binding, { repo: 'C:/work/app', commit: COMMIT, lockSha256: LOCK });
    assert.equal(draft.window, null);
  });

  it('reads a pod-exec bound to an image, with a preview and inline code', () => {
    const parse = parseDraft(
      dbWrite({ kind: 'pod-exec', binding: { image: IMAGE }, argv: ['kubectl', 'exec', 'worker-0', '--', 'node', '-e', 'console.log(1)'], dryRunArgv: null, preview: 'GET /health' }),
      scanner,
    );
    assert.deepEqual(draftOf(parse).binding, { image: IMAGE });
  });

  it('normalizes a window to UTC instants', () => {
    const draft = draftOf(parseDraft(dbWrite({ window: { runAfter: '2030-01-07T12:00:00+03:00', expiresBy: '2030-01-07T11:00:00Z' } }), scanner));
    assert.deepEqual(draft.window, { runAfter: '2030-01-07T09:00:00.000Z', expiresBy: '2030-01-07T11:00:00.000Z' });
  });

  it('refuses a shell string, an empty argv and a missing field, listing every problem', () => {
    const problems = problemsOf(parseDraft(dbWrite({ argv: 'node tools/fix.ts --apply', purpose: '', rerunSafe: 'yes' }), scanner));
    assert.equal(problems.length, 3, problems.join('; '));
    assert.match(problems[0] ?? '', /argv is required, as a JSON array of strings.*never a shell string/u);
    assert.ok(problems.some((problem) => problem.startsWith('purpose is required')));
    assert.ok(problems.some((problem) => problem.startsWith('rerunSafe is required')));
    assert.match(problemsOf(parseDraft(dbWrite({ argv: [] }), scanner))[0] ?? '', /^argv is required/u);
    assert.deepEqual(problemsOf(parseDraft([], scanner)), ['the request file is one JSON object']);
  });

  it('refuses inline code in a write, wherever it sits, but not in a pod-exec', () => {
    const node = problemsOf(parseDraft(dbWrite({ argv: ['node', '--eval=require("x")'] }), scanner));
    assert.match(node[0] ?? '', /inline code \(--eval=require\("x"\)\): a db-write runs a committed script/u);
    const dbShell = problemsOf(parseDraft(dbWrite({ kind: 'route', argv: ['dbshell', 'db://127.0.0.1/app', '--eval', 'db.x.drop()'] }), scanner));
    assert.match(dbShell[0] ?? '', /inline code \(--eval\)/u);
  });

  it('binds a write by commit and a pod-exec by image digest', () => {
    assert.match(problemsOf(parseDraft(dbWrite({ binding: { image: IMAGE } }), scanner))[0] ?? '', /a db-write runs code bound by commit/u);
    const unpinned = problemsOf(parseDraft(dbWrite({ kind: 'pod-exec', binding: { image: 'registry/worker:latest' }, dryRunArgv: null, preview: 'GET /x' }), scanner));
    assert.match(unpinned[0] ?? '', /pinned by digest/u);
    const committed = problemsOf(parseDraft(dbWrite({ kind: 'pod-exec', dryRunArgv: null, preview: 'GET /x' }), scanner));
    assert.match(committed[0] ?? '', /a pod-exec binds the target image/u);
    const short = problemsOf(parseDraft(dbWrite({ binding: { repo: 'repo', commit: 'abc1234', lockSha256: 'x' } }), scanner));
    assert.equal(short.length, 3, short.join('; '));
  });

  it('needs a dry run for a db-write and a dry run or preview for every kind', () => {
    assert.match(problemsOf(parseDraft(dbWrite({ dryRunArgv: null, preview: 'GET /x' }), scanner))[0] ?? '', /a db-write needs dryRunArgv/u);
    assert.match(problemsOf(parseDraft(dbWrite({ kind: 'route', dryRunArgv: null }), scanner))[0] ?? '', /or a preview/u);
    draftOf(parseDraft(dbWrite({ kind: 'route', dryRunArgv: null, preview: 'GET /admin/x shows 3 rows' }), scanner));
  });

  it('refuses a secret in argv or any text, naming the field and never the value', () => {
    const problems = problemsOf(parseDraft(dbWrite({ argv: ['node', 'tools/fix.ts', ['db://admin:', 'hunter22', '@127.0.0.1/app'].join('')] }), scanner));
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^argv\[2\] looks like it holds a secret \(credentials in a URL\).*envNames/u);
    assert.doesNotMatch(problems[0] ?? '', /hunter22/u);
  });

  it('refuses variable values, duplicates, a bad task id, a relative cwd, a bad runtime and a backwards window', () => {
    const problems = problemsOf(
      parseDraft(
        dbWrite({
          envNames: ['DB_URI=db://x'],
          readEnvNames: ['A', 'A'],
          task: '755',
          cwd: 'app',
          maxRuntimeSec: 99_999,
          window: { runAfter: '2030-01-07T12:00:00Z', expiresBy: '2030-01-07T11:00:00Z' },
          kind: 'drop',
        }),
        scanner,
      ),
    );
    assert.equal(problems.length, 7, problems.join('; '));
  });
});

describe('readStoredRequest (T755)', () => {
  it('reads a stored request back unchanged, so its hash still matches', () => {
    const stored = request(draftOf(parseDraft(dbWrite({ window: { runAfter: '2030-01-07T09:00:00.000Z', expiresBy: '2030-01-07T11:00:00.000Z' } }), scanner)));
    const back = readStoredRequest(JSON.parse(JSON.stringify(stored)));
    assert.deepEqual(back, stored);
    assert.equal(back === undefined ? '' : requestSha256(back), requestSha256(stored));
  });

  it("checks the shape only, not today's rules", () => {
    const accepted = { ...request(draftOf(parseDraft(dbWrite(), scanner))), dryRunArgv: null, dryRunProgram: null, preview: null };
    assert.deepEqual(readStoredRequest(accepted), accepted);
  });

  it('gives undefined for a malformed record', () => {
    const stored = request(draftOf(parseDraft(dbWrite(), scanner)));
    assert.equal(readStoredRequest([]), undefined);
    assert.equal(readStoredRequest({ ...stored, id: '' }), undefined);
    assert.equal(readStoredRequest({ ...stored, argv: 'node x.ts' }), undefined);
    assert.equal(readStoredRequest(Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'program'))), undefined);
  });
});

describe('inlineCodeOption and programLookup (T755)', () => {
  it('finds interpreter inline-code options, case-insensitively, and nothing in a script call', () => {
    assert.equal(inlineCodeOption(['pwsh', '-NoProfile', '-Command', 'Remove-Item x']), '-Command');
    assert.equal(inlineCodeOption(['python', '-c', 'print(1)']), '-c');
    assert.equal(inlineCodeOption(['node', 'tools/fix.ts', '--apply']), undefined);
    assert.equal(inlineCodeOption(['-e']), undefined, 'argv[0] is the program');
  });

  it('takes an absolute path or a bare name, and refuses a relative path', () => {
    assert.deepEqual(programLookup('C:\\nodejs\\node.exe'), { kind: 'absolute', path: 'C:\\nodejs\\node.exe' });
    assert.deepEqual(programLookup('/usr/bin/node'), { kind: 'absolute', path: '/usr/bin/node' });
    assert.deepEqual(programLookup('kubectl'), { kind: 'name', name: 'kubectl' });
    assert.equal(programLookup('./node_modules/.bin/tsx').kind, 'refused');
    assert.equal(programLookup('bin\\tool.exe').kind, 'refused');
  });
});

describe('request digests (T755)', () => {
  it('hashes the resolved program with the arguments, and the whole request whatever its key order', () => {
    const one = request(draftOf(parseDraft(dbWrite(), scanner)));
    assert.equal(argvSha256(one), sha256Hex(canonicalJson(['C:/nodejs/node.exe', 'tools/fix-models.ts', '--apply'])));
    assert.notEqual(argvSha256({ ...one, program: 'C:/evil/node.exe' }), argvSha256(one));
    assert.equal(requestSha256(one), sha256Hex(canonicalJson(one)));
    assert.notEqual(requestSha256({ ...one, envNames: ['CLOUD_DB_URI'] }), requestSha256(one));
  });

  it('writes canonical JSON with sorted keys at every depth', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  });
});

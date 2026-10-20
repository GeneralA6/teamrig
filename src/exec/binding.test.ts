import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import type { PathKind, PathProbe } from '../core/path-probe.ts';
import type { PathSearchDeps } from '../core/path-search.ts';
import { execRequest } from '../testing/exec-request.ts';
import { bindingProblems, GIT_CHECKOUT, resolveProgram, type BindingDeps, type CheckoutProbe } from './binding.ts';

const REPO = 'C:/work/app';
const COMMIT = 'a'.repeat(40);
const LOCK_SHA = 'b'.repeat(64);
const NODE = 'C:/nodejs/node.exe';

/** A checkout that answers from fields a test sets: by default the fixture request's bound, clean repository. */
class FakeCheckout implements CheckoutProbe {
  top: string | undefined = REPO;
  commit: string | undefined = COMMIT;
  changed: readonly string[] | undefined = [];
  readonly files = new Map<string, string>([[win32.join(REPO, 'package-lock.json'), LOCK_SHA]]);

  async topLevel(): Promise<string | undefined> {
    return this.top;
  }

  async head(): Promise<string | undefined> {
    return this.commit;
  }

  async changes(): Promise<readonly string[] | undefined> {
    return this.changed;
  }

  async fileSha256(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
}

/** A filesystem that holds only the given files. */
function probeOf(...files: string[]): PathProbe {
  const held = new Set(files.map((file) => win32.normalize(file)));
  return { kind: async (path): Promise<PathKind> => (held.has(win32.normalize(path)) ? 'file' : 'none') };
}

function searchOf(path: string, ...files: string[]): PathSearchDeps {
  return { env: { PATH: path }, platform: 'win32', probe: probeOf(...files) };
}

function deps(checkout: CheckoutProbe = new FakeCheckout(), search: PathSearchDeps = searchOf('C:/nodejs', NODE)): BindingDeps {
  return { checkout, search };
}

describe('bindingProblems', () => {
  it('passes the bound, clean checkout whose program still resolves, for the run and the dry run', async () => {
    assert.deepEqual(await bindingProblems(execRequest(), 'run', deps()), []);
    assert.deepEqual(await bindingProblems(execRequest(), 'dry-run', deps()), []);
  });

  it('matches Windows paths whatever their case', async () => {
    const checkout = new FakeCheckout();
    checkout.top = 'c:/WORK/app';
    assert.deepEqual(await bindingProblems(execRequest(), 'run', deps(checkout)), []);
  });

  it('refuses an image binding, which cannot be checked yet', async () => {
    const request = execRequest({ kind: 'pod-exec', binding: { image: `reg/app@sha256:${'c'.repeat(64)}` } });
    const [problem] = await bindingProblems(request, 'run', deps());
    assert.match(problem ?? '', /binds an image/u);
  });

  it('refuses a dry run of a request that has none', async () => {
    assert.deepEqual(await bindingProblems(execRequest({ dryRunArgv: null, dryRunProgram: null }), 'dry-run', deps()), ['R1 has no dry run']);
  });

  it('names every way the checkout moved from the binding', async () => {
    const checkout = new FakeCheckout();
    checkout.top = 'C:/work/other';
    checkout.commit = 'd'.repeat(40);
    checkout.changed = [' M tools/fix-models.ts', '?? tools/new.ts'];
    checkout.files.set(win32.join(REPO, 'package-lock.json'), 'e'.repeat(64));
    const problems = await bindingProblems(execRequest(), 'run', deps(checkout));
    assert.deepEqual(problems, [
      'cwd C:/work/app is in the checkout C:/work/other, not the bound C:/work/app',
      'C:/work/app is at dddddddddddd, bound to aaaaaaaaaaaa',
      'C:/work/app has 2 uncommitted change(s): commit or remove them',
      'package-lock.json changed since the request (SHA-256 eeeeeeeeeeee, bound bbbbbbbbbbbb)',
    ]);
  });

  it('refuses when git cannot read the checkout', async () => {
    const checkout = new FakeCheckout();
    checkout.top = undefined;
    checkout.commit = undefined;
    checkout.changed = undefined;
    const problems = await bindingProblems(execRequest(), 'run', deps(checkout));
    assert.deepEqual(problems, ['cwd C:/work/app is in no git checkout', 'C:/work/app is at no commit, bound to aaaaaaaaaaaa', 'git status cannot read C:/work/app']);
  });

  it('needs exactly one lockfile', async () => {
    const none = new FakeCheckout();
    none.files.clear();
    assert.match((await bindingProblems(execRequest(), 'run', deps(none))).join(), /has no lockfile/u);
    const two = new FakeCheckout();
    two.files.set(win32.join(REPO, 'pnpm-lock.yaml'), LOCK_SHA);
    assert.deepEqual(await bindingProblems(execRequest(), 'run', deps(two)), ['C:/work/app has 2 lockfiles (package-lock.json, pnpm-lock.yaml): keep one']);
  });

  it('refuses a program that now resolves to another file, or to none', async () => {
    const shadowed = searchOf('C:/evil;C:/nodejs', 'C:/evil/node.exe', NODE);
    assert.deepEqual(await bindingProblems(execRequest(), 'run', deps(new FakeCheckout(), shadowed)), [
      'node now resolves to C:\\evil\\node.exe, not the reviewed C:/nodejs/node.exe',
    ]);
    const gone = searchOf('C:/nodejs');
    assert.deepEqual(await bindingProblems(execRequest(), 'dry-run', deps(new FakeCheckout(), gone)), ['node now resolves to nothing, not the reviewed C:/nodejs/node.exe']);
  });
});

describe('resolveProgram', () => {
  it('finds a name on the exec PATH, and an absolute path only when it is a file', async () => {
    const search = searchOf('C:/nodejs', NODE);
    assert.equal(await resolveProgram('node', search), win32.join('C:/nodejs', 'node.exe'));
    assert.equal(await resolveProgram(NODE, search), NODE);
    assert.equal(await resolveProgram('C:/nodejs/missing.exe', search), undefined);
    assert.equal(await resolveProgram('tools/node', search), undefined);
  });
});

describe('GIT_CHECKOUT', () => {
  it('reads a real checkout: its root, commit, changes and a file hash', async () => {
    const repo = new TempRepo('exec-binding').init();
    try {
      repo.write('package-lock.json', '{"lockfileVersion":3}\n');
      repo.git('add', 'package-lock.json');
      repo.git('commit', '-q', '-m', 'first');
      const commit = repo.git('rev-parse', 'HEAD').trim();
      assert.equal(await GIT_CHECKOUT.head(repo.dir), commit);
      assert.ok(win32.relative(win32.resolve((await GIT_CHECKOUT.topLevel(repo.dir)) ?? ''), win32.resolve(repo.dir)) === '');
      assert.deepEqual(await GIT_CHECKOUT.changes(repo.dir), []);
      repo.write('new.ts', 'x');
      assert.deepEqual(await GIT_CHECKOUT.changes(repo.dir), ['?? new.ts']);
      const lock = win32.join(repo.dir, 'package-lock.json');
      assert.equal(await GIT_CHECKOUT.fileSha256(lock), createHash('sha256').update('{"lockfileVersion":3}\n').digest('hex'));
      assert.equal(await GIT_CHECKOUT.fileSha256(win32.join(repo.dir, 'yarn.lock')), undefined);
    } finally {
      repo.remove();
    }
  });
});

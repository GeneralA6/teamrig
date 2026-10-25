import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join, relative, resolve, win32 } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import type { PathSearchDeps } from '../core/path-search.ts';
import { execRequest } from '../testing/exec-request.ts';
import { FakeCheckout, searchOf } from '../testing/fake-checkout.ts';
import { bindingProblems, GIT_CHECKOUT, resolveProgram, type BindingDeps, type CheckoutProbe } from './binding.ts';

const REPO = 'C:/work/app';
const LOCK_SHA = 'b'.repeat(64);
const NODE = 'C:/nodejs/node.exe';

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
      assert.ok(relative(resolve((await GIT_CHECKOUT.topLevel(repo.dir)) ?? ''), resolve(repo.dir)) === '');
      assert.deepEqual(await GIT_CHECKOUT.changes(repo.dir), []);
      repo.write('new.ts', 'x');
      assert.deepEqual(await GIT_CHECKOUT.changes(repo.dir), ['?? new.ts']);
      const lock = join(repo.dir, 'package-lock.json');
      assert.equal(await GIT_CHECKOUT.fileSha256(lock), createHash('sha256').update('{"lockfileVersion":3}\n').digest('hex'));
      assert.equal(await GIT_CHECKOUT.fileSha256(join(repo.dir, 'yarn.lock')), undefined);
    } finally {
      repo.remove();
    }
  });
});

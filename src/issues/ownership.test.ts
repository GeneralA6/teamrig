import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HeadRead } from './host.ts';
import { adminText, branchTaskId, writeRight, type AdminView, type OwnedTask, type RightFacts } from './ownership.ts';

const TARGET = { repo: 'acme/web', number: 7 };
const REF = 'gh:acme/web#7';
const TASKS: readonly OwnedTask[] = [
  { id: 'T12', owner: 'alpha', ref: REF },
  { id: 'T13', owner: 'beta', ref: null },
  { id: 'T14', owner: 'alpha', ref: null },
];
const NO_ADMIN: AdminView = { session: undefined, text: adminText(undefined, undefined) };
const BETA_ADMIN: AdminView = { session: 'beta', text: adminText('beta', undefined) };

/** The facts for `caller`, counting how often the admin and the head were read. */
function factsFor(caller: string, admin: AdminView, head: HeadRead, reads: string[] = []): RightFacts {
  return {
    caller,
    target: TARGET,
    ref: REF,
    tasks: TASKS,
    admin: () => {
      reads.push('admin');
      return Promise.resolve(admin);
    },
    head: () => {
      reads.push('head');
      return Promise.resolve(head);
    },
  };
}

describe('branchTaskId', () => {
  it('reads the task a t<id>- branch is named for, and nothing from any other branch', () => {
    assert.equal(branchTaskId('t12-fix-the-guard'), 'T12');
    assert.equal(branchTaskId('T2705-github-admin-role'), 'T2705');
    for (const branch of ['main', 't12', 'fix-t12-x', 't0-x', 'tt12-x', 'feature/t12-x']) {
      assert.equal(branchTaskId(branch), undefined, branch);
    }
  });
});

describe('writeRight (T2705)', () => {
  it('lets a session write on an issue its own task has as its ref, reading neither the admin nor the host', async () => {
    const reads: string[] = [];
    assert.deepEqual(await writeRight(factsFor('alpha', NO_ADMIN, { kind: 'no-pull' }, reads)), { kind: 'allowed', why: 'T12 of alpha has it as its ref' });
    assert.deepEqual(reads, []);
  });

  it('lets the admin write on anything, without reading the host', async () => {
    const reads: string[] = [];
    assert.deepEqual(await writeRight(factsFor('beta', BETA_ADMIN, { kind: 'no-pull' }, reads)), { kind: 'allowed', why: 'beta is the GitHub admin' });
    assert.deepEqual(reads, ['admin']);
  });

  it("lets a session write on a pull request from a t<id>- branch of its own task in the same repository", async () => {
    const right = await writeRight({ ...factsFor('alpha', BETA_ADMIN, { kind: 'pull', branch: 't14-docs', repo: 'acme/web' }), ref: 'gh:acme/web#8' });
    assert.deepEqual(right, { kind: 'allowed', why: 'its branch is one of T14 of alpha' });
  });

  it("refuses another session's issue, naming the admin who may write on it", async () => {
    assert.deepEqual(await writeRight(factsFor('beta', NO_ADMIN, { kind: 'no-pull' })), {
      kind: 'refused',
      reason:
        'beta may write only on its own issues and pull requests, and acme/web#7 is not one: no task of beta has it as its ref, and it is no pull request; the GitHub admin writes on the rest, and none is set: the owner names one with teamrig owner github-admin <session>',
    });
    const gammaAsks = await writeRight(factsFor('gamma', BETA_ADMIN, { kind: 'no-pull' }));
    assert.ok(gammaAsks.kind === 'refused' && gammaAsks.reason.endsWith('; the GitHub admin, beta, writes on the rest'));
  });

  it("refuses a pull request from another session's task branch, from a branch named for no task, and from a fork", async () => {
    const cases: Array<[HeadRead, string]> = [
      [{ kind: 'pull', branch: 't13-x', repo: 'acme/web' }, "its pull request's branch t13-x is no t<id>- branch of a task of alpha"],
      [{ kind: 'pull', branch: 'patch-1', repo: 'acme/web' }, "its pull request's branch patch-1 is no t<id>- branch of a task of alpha"],
      [{ kind: 'pull', branch: 't14-docs', repo: 'stranger/web' }, "its pull request's branch t14-docs is in stranger/web, not acme/web"],
      [{ kind: 'pull', branch: 't14-docs', repo: null }, "its pull request's branch t14-docs is in a fork since deleted, not acme/web"],
    ];
    for (const [head, text] of cases) {
      const right = await writeRight({ ...factsFor('alpha', NO_ADMIN, head), ref: 'gh:acme/web#8' });
      assert.ok(right.kind === 'refused' && right.reason.includes(`and ${text};`), JSON.stringify(right));
    }
  });

  it('says it cannot tell when the host could not be read, so nothing is written', async () => {
    assert.deepEqual(await writeRight(factsFor('beta', NO_ADMIN, { kind: 'failed', reason: 'gh is not logged in' })), {
      kind: 'unknown',
      reason: 'could not tell whose acme/web#7 is: gh is not logged in',
    });
  });
});

describe('adminText', () => {
  it('names the admin, none, or why the role reads broken', () => {
    assert.equal(adminText('beta', undefined), 'the GitHub admin, beta, writes on the rest');
    assert.match(adminText(undefined, 'the file was changed'), /^the GitHub admin writes on the rest, and the role reads broken \(the file was changed\): the owner names one/);
  });
});

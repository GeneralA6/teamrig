import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_TABLE } from '../cli/run.ts';
import { readable } from '../slash/plan.ts';
import { shipCallOf, shipNearMissOf, shipRunOf, type ShipCallContext } from './ship-role-call.ts';

const TOOL = '/repo/.ship/tools/ship/ship.ts';
const WORKTREE = '/repo/.worktrees/t7-fix';
const PLAN = '/kit/teams/app/tasks/T7/plan.json';
const NOTE = '/kit/teams/app/tasks/T7/pr.md';
const SHA = '0123456789abcdef0123456789abcdef01234567';
/** The repository's main checkout, the folder a release merge names (T4672). */
const MAIN = '/repo/app';

const CONTEXT: ShipCallContext = { cli: COMMAND_TABLE, ownClient: async (word) => word === 'teamrig', isShipTool: (word) => word === TOOL };

/** The ship run of `teamrig queue <queue> -- <rest>`, read as the CLI reads it. */
async function callOf(queue: string, rest: string, program = 'teamrig'): Promise<unknown> {
  const words = [...queue.split(' ').filter((word) => word !== ''), '--', ...rest.split(' ')];
  const parsed = readable(words, COMMAND_TABLE);
  assert.ok(parsed !== undefined, `${queue} -- ${rest}`);
  return shipCallOf(program, parsed, CONTEXT);
}

const QUEUE = 'queue --detach --session alpha --what fix --task T7 --kind test --max-minutes 45';

describe('ship role call: the tool line (T2984)', () => {
  it('reads a ship, a ship that merges, and the merge form, with the files each reads', () => {
    const isTool = CONTEXT.isShipTool;
    assert.deepEqual(shipRunOf(['node', TOOL, WORKTREE, PLAN], isTool, 'T7'), { tool: TOOL, worktree: WORKTREE, files: [PLAN], task: 'T7', merges: false, release: undefined });
    assert.deepEqual(shipRunOf(['node', '--disable-warning=ExperimentalWarning', TOOL, WORKTREE, PLAN, '--merge', '--approved', SHA, '--note-file', NOTE], isTool, undefined), {
      tool: TOOL,
      worktree: WORKTREE,
      files: [PLAN, NOTE],
      task: undefined,
      merges: true,
      release: undefined,
    });
    assert.deepEqual(shipRunOf(['node', TOOL, 'merge', WORKTREE, '--note-file', NOTE, '--approved', 'abc1234'], isTool, 'T7'), {
      tool: TOOL,
      worktree: WORKTREE,
      files: [NOTE],
      task: 'T7',
      merges: true,
      release: undefined,
    });
    assert.equal(shipRunOf(['node', TOOL, 'merge', WORKTREE], isTool, undefined)?.merges, true);
  });

  it('reads no other program, tool, path, form or flag', () => {
    for (const rest of [
      ['npx', TOOL, WORKTREE, PLAN],
      ['node', '--import=x', TOOL, WORKTREE, PLAN],
      ['node', '/repo/tools/ship/ship.ts', WORKTREE, PLAN],
      ['node', TOOL, 'repo/.worktrees/t7-fix', PLAN],
      ['node', TOOL, WORKTREE, 'plan.json'],
      ['node', TOOL, WORKTREE],
      ['node', TOOL, WORKTREE, PLAN, 'origin/dev'],
      ['node', TOOL, WORKTREE, PLAN, '--merge', '--merge'],
      ['node', TOOL, WORKTREE, PLAN, '--approved', SHA],
      ['node', TOOL, WORKTREE, PLAN, '--note-file', NOTE],
      ['node', TOOL, WORKTREE, PLAN, '--merge', '--approved', 'HEAD'],
      ['node', TOOL, WORKTREE, PLAN, '--merge', '--approved', SHA, '--approved', SHA],
      ['node', TOOL, WORKTREE, PLAN, '--merge', '--note-file', 'pr.md'],
      ['node', TOOL, WORKTREE, PLAN, '--merge', '--note-file', NOTE, '--note-file', NOTE],
      ['node', TOOL, WORKTREE, PLAN, '--merge', '--approved'],
      ['node', TOOL, 'merge', WORKTREE, '--merge'],
      ['node', TOOL, 'merge', WORKTREE, '--head', SHA],
      ['node', TOOL, 'merge', WORKTREE, '--timeout-min', '5'],
      ['node', TOOL, 'check', WORKTREE],
      ['node', TOOL, 'leftovers', WORKTREE],
      ['node'],
      [],
    ]) {
      assert.equal(shipRunOf(rest, CONTEXT.isShipTool, undefined), undefined, rest.join(' '));
    }
  });

  it('reads the release merge with its task and approved sha, and no note file (T4672)', () => {
    assert.deepEqual(shipRunOf(['node', TOOL, 'merge', MAIN, '--release', 'T9', '--approved', SHA], CONTEXT.isShipTool, 'T9'), {
      tool: TOOL,
      worktree: MAIN,
      files: [],
      task: 'T9',
      merges: true,
      release: 'T9',
    });
    assert.equal(shipRunOf(['node', TOOL, 'merge', MAIN, '--approved', SHA, '--release', 'T9'], CONTEXT.isShipTool, undefined)?.release, 'T9', 'in either order');
  });

  it('reads no release merge without an approved sha, with a note file, a second release, a word off a task id, or outside the merge form (T4672)', () => {
    for (const rest of [
      ['node', TOOL, 'merge', MAIN, '--release', 'T9'],
      ['node', TOOL, 'merge', MAIN, '--release', 'T9', '--approved', SHA, '--note-file', NOTE],
      ['node', TOOL, 'merge', MAIN, '--release', 'T9', '--release', 'T9', '--approved', SHA],
      ['node', TOOL, 'merge', MAIN, '--release', '9', '--approved', SHA],
      ['node', TOOL, 'merge', MAIN, '--release', 'T9;x', '--approved', SHA],
      ['node', TOOL, 'merge', MAIN, '--release', '--approved', SHA],
      ['node', TOOL, 'merge', MAIN, '--release', 'T9', '--head', 'release-branch', '--approved', SHA],
      ['node', TOOL, 'merge', 'repo/app', '--release', 'T9', '--approved', SHA],
      ['node', TOOL, WORKTREE, PLAN, '--merge', '--release', 'T9', '--approved', SHA],
    ]) {
      assert.equal(shipRunOf(rest, CONTEXT.isShipTool, undefined), undefined, rest.join(' '));
    }
  });
});

describe('ship role call: the queue line (T2984)', () => {
  it('reads a queued ship under --kind test, and a merge under --kind ship or merge, through the own launcher (T3414)', async () => {
    assert.deepEqual(await callOf(QUEUE, `node ${TOOL} ${WORKTREE} ${PLAN}`), { tool: TOOL, worktree: WORKTREE, files: [PLAN], task: 'T7', merges: false, release: undefined });
    assert.deepEqual(await callOf('queue --kind merge', `node ${TOOL} merge ${WORKTREE}`), { tool: TOOL, worktree: WORKTREE, files: [], task: undefined, merges: true, release: undefined });
    assert.equal((await callOf('queue --kind ship', `node ${TOOL} ${WORKTREE} ${PLAN} --merge`)) !== undefined, true);
  });

  it('reads no ship under a kind that does not fit it: one without --merge under a slot kind, a merge under test (T3414)', async () => {
    const misfits: readonly (readonly [string, string])[] = [
      ['queue --kind ship', `node ${TOOL} ${WORKTREE} ${PLAN}`],
      ['queue --kind merge', `node ${TOOL} ${WORKTREE} ${PLAN}`],
      ['queue --kind test', `node ${TOOL} ${WORKTREE} ${PLAN} --merge`],
      ['queue --kind test', `node ${TOOL} merge ${WORKTREE}`],
      ['queue --kind build', `node ${TOOL} ${WORKTREE} ${PLAN}`],
    ];
    for (const [queue, rest] of misfits) {
      assert.equal(await callOf(queue, rest), undefined, `${queue} -- ${rest}`);
    }
  });

  it('reads no queue line without a ship kind, with another option, a positional or help, or through another launcher', async () => {
    const rest = `node ${TOOL} ${WORKTREE} ${PLAN}`;
    for (const queue of ['queue --what fix', 'queue --kind lint', 'queue --kind test --exclusive', 'queue --kind test --memory-mb 900', 'queue --kind test --pre-push', 'queue --kind test x']) {
      assert.equal(await callOf(queue, rest), undefined, queue);
    }
    assert.equal(await callOf('queue --kind test', rest, './teamrig'), undefined);
    const help = readable(['queue', '--kind', 'ship', '--help'], COMMAND_TABLE);
    assert.ok(help !== undefined);
    assert.equal(await shipCallOf('teamrig', help, CONTEXT), undefined);
    const test = readable(['test', '--', 'node', TOOL, WORKTREE, PLAN], COMMAND_TABLE);
    assert.ok(test !== undefined);
    assert.equal(await shipCallOf('teamrig', test, CONTEXT), undefined, 'another command that takes a line');
  });
});

/** The failed conditions of `<program> queue <queue> -- <rest>`, read from the folder `cwd`. */
async function missOf(queue: string, rest: string, cwd = '/repo', program = 'teamrig'): Promise<readonly string[]> {
  const words = [...queue.split(' ').filter((word) => word !== ''), '--', ...rest.split(' ')];
  const parsed = readable(words, COMMAND_TABLE);
  assert.ok(parsed !== undefined, `${queue} -- ${rest}`);
  return shipNearMissOf(program, parsed, CONTEXT, cwd);
}

const NAMED = 'queue --kind test --session alpha';
const NO_SESSION = 'no --session: a role call names the session it runs as';

describe('ship role call: a near miss names the condition it failed (#1468)', () => {
  it('names a missing --session, a relative tool path, an extra queue flag, a kind that does not fit and an extra tool word', async () => {
    assert.deepEqual(await missOf('queue --kind test', `node ${TOOL} ${WORKTREE} ${PLAN}`), [NO_SESSION]);
    assert.deepEqual(await missOf(NAMED, `node .ship/tools/ship/ship.ts ${WORKTREE} ${PLAN}`), [`the ship tool path .ship/tools/ship/ship.ts is relative: name it absolute, ${TOOL}`]);
    assert.deepEqual(await missOf(`${NAMED} --exclusive`, `node ${TOOL} ${WORKTREE} ${PLAN}`), ['the queue flag --exclusive is not one a ship call takes']);
    assert.deepEqual(await missOf('queue --kind ship --session alpha', `node ${TOOL} ${WORKTREE} ${PLAN}`), [
      '--kind ship does not fit the run: a merge runs under ship or merge, a ship without --merge under test',
    ]);
    assert.deepEqual(await missOf(NAMED, `node ${TOOL} ${WORKTREE} ${PLAN} --base main`), [
      "the ship tool's words are not its ship or merge form: an extra word or flag, or a worktree, plan or note path that is not absolute",
    ]);
    assert.deepEqual(await missOf('queue --kind merge --small', `node .ship/tools/ship/ship.ts merge ${WORKTREE}`), [
      `the ship tool path .ship/tools/ship/ship.ts is relative: name it absolute, ${TOOL}`,
      NO_SESSION,
      'the queue flag --small is not one a ship call takes',
    ]);
  });

  it('names nothing for the documented form, another tool or program, another launcher, or a relative path off the tool', async () => {
    const rest = `node ${TOOL} ${WORKTREE} ${PLAN}`;
    assert.deepEqual(await missOf(QUEUE, rest), []);
    assert.deepEqual(await missOf('queue --kind test', `node /repo/tools/other.ts ${WORKTREE} ${PLAN}`), []);
    assert.deepEqual(await missOf('queue --kind test', `npx ${TOOL} ${WORKTREE} ${PLAN}`), []);
    assert.deepEqual(await missOf('queue --kind test', rest, '/repo', './teamrig'), []);
    assert.deepEqual(await missOf(NAMED, `node .ship/tools/ship/ship.ts ${WORKTREE} ${PLAN}`, '/elsewhere'), []);
    const relative = readable([...NAMED.split(' '), '--', 'node', '.ship/tools/ship/ship.ts', WORKTREE, PLAN], COMMAND_TABLE);
    assert.ok(relative !== undefined);
    assert.deepEqual(await shipNearMissOf('teamrig', relative, CONTEXT, undefined), [], 'a relative path with no folder to read it from');
    const test = readable(['test', '--', 'node', TOOL, WORKTREE, PLAN], COMMAND_TABLE);
    assert.ok(test !== undefined);
    assert.deepEqual(await shipNearMissOf('teamrig', test, CONTEXT, '/repo'), [], 'another command that takes a line');
  });
});

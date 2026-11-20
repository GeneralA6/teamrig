import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { FakeMergeGit, MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { NO_PATHS_HOST } from '../testing/host.ts';
import { EXIT } from './runtime.ts';

const ANSWERS_LOG = join(TEAM_HOME, 'state', 'prompt-answers.jsonl');
const MARKS = join(TEAM_HOME, 'state', 'inbox-marks.jsonl');
const HOOK = ['hook', 'route-allow'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };
const ALPHA = { TEAMRIG_SESSION: 'alpha' };
/** A close with no --session, which no role call is (T2984). */
const UNNAMED = 'teamrig issue close acme/web#7 --comment "Fixed in #8; thanks!"';
const CLOSE = `${UNNAMED} --session alpha`;
/** A token shape the secret guard knows, built here so no token sits in the source. */
const TOKEN = ['gh', 'p_', 'a1'.repeat(18)].join('');

/** A team whose `github` role gives alpha issue close on acme/web. */
function roleTeam(extra: JsonRecord = {}): JsonRecord {
  return {
    ...TEAM,
    github: { repos: ['acme/web'] },
    serviceRoles: { github: { holders: ['alpha'], commands: ['issue close'] } },
    ...extra,
  };
}

function call(command: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: CLAUDE_SESSION, cwd: APP, tool_name: 'Bash', tool_input: { command }, ...fields });
}

/** Records that this test's Claude Code session read `area`'s inbox. */
async function mark(kit: CliHarness, area: string, claudeSession: string = CLAUDE_SESSION): Promise<void> {
  const record = { v: 1, area, line: 0, at: '2030-01-08T09:00:00.000Z', claudeSession, lastLineHash: null };
  await kit.files.append(MARKS, `${JSON.stringify(record)}\n`);
}

/** A harness with the role team, its tab bound to alpha. */
async function boundKit(extra: JsonRecord = {}): Promise<CliHarness> {
  const kit = new CliHarness(roleTeam(extra));
  await mark(kit, 'alpha');
  return kit;
}

function decisionOf(result: CliResult): unknown {
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  const output = isRecord(parsed) ? recordField(parsed, 'hookSpecificOutput') : undefined;
  return output?.['permissionDecision'];
}

async function answersOf(kit: CliHarness): Promise<unknown[]> {
  const text = (await kit.files.read(ANSWERS_LOG)) ?? '';
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

describe('hook route-allow: service roles', () => {
  it("allows the holder's call with asks on, logging the role, command and issue but never the text", async () => {
    const kit = await boundKit();
    const result = await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA });
    assert.equal(decisionOf(result), 'allow');
    assert.deepEqual(result.stderr, []);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call('teamrig issue close acme/web#9 --comment "Done in #10" --session alpha'), env: {} })), 'allow');
    assert.deepEqual(await answersOf(kit), [
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'role', role: 'github', command: 'issue close', target: 'acme/web#7' },
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'role', role: 'github', command: 'issue close', target: 'acme/web#9' },
    ]);
    assert.ok(!(await kit.files.read(ANSWERS_LOG))?.includes('thanks'));
  });

  it("gives a tab bound to alpha no role of bravo's, whether it read bravo's inbox or names bravo (C1)", async () => {
    const bravoHolds = { serviceRoles: { github: { holders: ['bravo'], commands: ['issue close'] } } };
    const read = await boundKit(bravoHolds);
    await mark(read, 'bravo');
    assert.deepEqual(await read.run(HOOK, { stdin: call(`${UNNAMED} --session bravo`), env: { TEAMRIG_SESSION: 'bravo' } }), NOTHING);
    const named = await boundKit(bravoHolds);
    assert.deepEqual(await named.run(HOOK, { stdin: call(`${UNNAMED} --session bravo`), env: ALPHA }), NOTHING);
    assert.deepEqual(await (await boundKit()).run(HOOK, { stdin: call(UNNAMED), env: ALPHA }), NOTHING, "the holder's call naming no session, though the environment names alpha (N1)");
    const holder = await boundKit();
    assert.deepEqual(await holder.run(HOOK, { stdin: call(`${UNNAMED} --session bravo`), env: ALPHA }), NOTHING, "alpha's tab running as bravo");
    assert.deepEqual(await answersOf(read), []);
  });

  it('gives no role to a tab with no mark, another tab, no Claude Code session, or no session to run as', async () => {
    const unmarked = new CliHarness(roleTeam());
    await mark(unmarked, 'alpha', 'ffffffff-0000-4000-8000-000000000001');
    assert.deepEqual(await unmarked.run(HOOK, { stdin: call(CLOSE), env: ALPHA }), NOTHING);
    const kit = await boundKit();
    assert.deepEqual(await kit.run(HOOK, { stdin: call(CLOSE, { session_id: 'not-an-id' }), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call(UNNAMED), env: {} }), NOTHING);
  });

  it('gives no role for a call off its shape, a repository off the list, or a bare comment, which no role holds (T3169)', async () => {
    const kit = await boundKit();
    for (const line of ['teamrig issue comment acme/web#7 --body "x" --session alpha', 'teamrig issue close other/web#7 --session alpha', `${CLOSE}; rm -rf y`, 'teamrig issue sync']) {
      assert.deepEqual(await kit.run(HOOK, { stdin: call(line), env: ALPHA }), NOTHING, line);
    }
    assert.deepEqual(await kit.run(HOOK, { stdin: call(CLOSE, { tool_name: 'PowerShell' }), env: ALPHA }), NOTHING);
  });

  it('stays out when a guard refuses the call, so that guard answers it', async () => {
    const kit = await boundKit();
    assert.deepEqual(await kit.run(HOOK, { stdin: call(`teamrig issue close acme/web#7 --comment "${TOKEN}" --session alpha`), env: ALPHA }), NOTHING);
    assert.deepEqual(await answersOf(kit), []);
  });

  it('refuses once the role ran its daily cap, and counts a rolling day (C6, T3356)', async () => {
    const kit = await boundKit({ prompts: { serviceRoleDailyCap: 2 } });
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'allow');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'allow');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'deny');
    assert.equal((await answersOf(kit)).length, 2);
    kit.clock.advance(24 * 60 * 60 * 1000 + 1);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'allow');
    const refusing = await boundKit({ prompts: { hookAsks: 'refuse', serviceRoleDailyCap: 0 } });
    assert.equal(decisionOf(await refusing.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'deny');
  });

  it('gives no role with the switch off, with any config issue, or when the log cannot be written', async () => {
    const off = await boundKit({ prompts: { routeAllow: 'off' } });
    assert.deepEqual(await off.run(HOOK, { stdin: call(CLOSE), env: ALPHA }), NOTHING);
    const broken = await boundKit({ prompts: { serviceRoleDailyCap: 500 } });
    assert.deepEqual(await broken.run(HOOK, { stdin: call(CLOSE), env: ALPHA }), NOTHING);
    const full = await boundKit();
    const files = new FaultyFiles(full.files).fail('append', ANSWERS_LOG, systemError('ENOSPC'));
    assert.deepEqual(await full.run(HOOK, { stdin: call(CLOSE), env: ALPHA, files }), NOTHING);
  });
});

const SHIP_TOOL = '/repo/ship/tools/ship/ship.ts';
const SHIP_WORKTREE = '/repo/app/.claude/worktrees/t1-cli';
/** The team's tasks folder with forward slashes, as a role call's line spells a path on every OS. */
const TASKS = join(TEAM_HOME, 'tasks').replaceAll('\\', '/');
const TASK_FILES = `${TASKS}/T1`;
/** A ship without --merge, a test step that takes no ship slot (T3414); a merge runs under --kind ship. */
const SHIP = `teamrig queue --kind test --what "ship T1" --task T1 --session alpha -- node ${SHIP_TOOL} ${SHIP_WORKTREE} ${TASK_FILES}/plan.json`;
const MERGING = SHIP.replace('--kind test', '--kind ship');
const MERGE = `${MERGING} --merge --approved 0123456 --note-file ${TASK_FILES}/pr.md`;

/** A team whose `ship` role gives every session the ship tool of repo app, which its tab bound to alpha runs on T1, alpha's. */
async function shipKit(extra: JsonRecord = {}): Promise<{ kit: CliHarness; git: FakeMergeGit }> {
  const kit = new CliHarness({
    ...TEAM,
    delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, shipTool: SHIP_TOOL } } },
    serviceRoles: { ship: { holders: 'team', commands: ['queue ship', 'queue merge'] } },
    ...extra,
  });
  assert.equal((await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha'])).code, EXIT.ok);
  await mark(kit, 'alpha');
  const git = new FakeMergeGit();
  git.checkouts.set(SHIP_WORKTREE, { top: SHIP_WORKTREE, branch: 't1-cli', mainCheckout: MAIN_CHECKOUT, linked: true });
  const shipCheckout = { top: '/repo/ship', branch: undefined, mainCheckout: MAIN_CHECKOUT, linked: true };
  git.checkouts.set('/repo/ship', shipCheckout);
  git.checkouts.set('/repo/ship/tools/ship', shipCheckout);
  git.heads.set('/repo/ship', 'base');
  git.tracking.set('origin/main', 'base');
  return { kit, git };
}

describe('hook route-allow: the ship role (T2984)', () => {
  it("allows a queued ship and merge of the holder's own task branch, logging the branch, and counts neither toward the cap (C4, C6)", async () => {
    const { kit, git } = await shipKit({ prompts: { serviceRoleDailyCap: 1 } });
    for (const line of [SHIP, MERGE, MERGE]) {
      const result = await kit.run(HOOK, { stdin: call(line), env: ALPHA, mergeGit: git });
      assert.equal(decisionOf(result), 'allow', line);
      assert.deepEqual(result.stderr, []);
    }
    const [first, second] = await answersOf(kit);
    assert.deepEqual(first, { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'role', role: 'ship', command: 'queue ship', target: 't1-cli' });
    assert.ok(isRecord(second) && second['command'] === 'queue merge' && second['target'] === 't1-cli');
  });

  it("gives no ship of another session's task, another task's files, or a worktree off the repository's folder (C4)", async () => {
    const { kit, git } = await shipKit();
    const lines = [
      SHIP.replace('--task T1', '--task T2'),
      `${MERGING} --merge --note-file ${TASKS}/T2/pr.md`,
      MERGING,
      `${SHIP} --merge --approved 0123456`,
      SHIP.replace(`${TASK_FILES}/plan.json`, '/tmp/plan.json'),
      SHIP.replace(SHIP_WORKTREE, '/w/feat'),
      SHIP.replace(SHIP_TOOL, '/repo/app/tools/ship/ship.ts'),
    ];
    for (const line of lines) {
      assert.deepEqual(await kit.run(HOOK, { stdin: call(line), env: ALPHA, mergeGit: git }), NOTHING, line);
    }
    assert.deepEqual(await kit.run(HOOK, { stdin: call(SHIP.replace('--session alpha', '--session bravo')), env: ALPHA, mergeGit: git }), NOTHING, "alpha's tab running as bravo");
    assert.deepEqual(await kit.run(HOOK, { stdin: call(SHIP.replace(' --session alpha', '')), env: ALPHA, mergeGit: git }), NOTHING, 'no --session, whatever the environment says (N1)');
    const bravos = await shipKit();
    assert.equal((await bravos.kit.run(['add', '--title', 'Ship the API', '--description', 'what and why', '--priority', 'p1', '--owner', 'bravo', '--session', 'lead'])).code, EXIT.ok);
    bravos.git.checkouts.set(SHIP_WORKTREE, { top: SHIP_WORKTREE, branch: 't2-api', mainCheckout: MAIN_CHECKOUT, linked: true });
    const bravoShip = SHIP.replace('--task T1', '--task T2').replace(`${TASK_FILES}/`, `${TASKS}/T2/`);
    assert.deepEqual(await bravos.kit.run(HOOK, { stdin: call(bravoShip), env: ALPHA, mergeGit: bravos.git }), NOTHING, "bravo's task");
    const main = await shipKit();
    main.git.checkouts.set(SHIP_WORKTREE, { top: SHIP_WORKTREE, branch: 'main', mainCheckout: MAIN_CHECKOUT, linked: true });
    assert.deepEqual(await main.kit.run(HOOK, { stdin: call(SHIP), env: ALPHA, mergeGit: main.git }), NOTHING, 'a protected branch');
    const other = await shipKit();
    other.git.checkouts.set(SHIP_WORKTREE, { top: SHIP_WORKTREE, branch: 't1-cli', mainCheckout: '/repo/other', linked: true });
    assert.deepEqual(await other.kit.run(HOOK, { stdin: call(SHIP), env: ALPHA, mergeGit: other.git }), NOTHING, "another repository's worktree");
    assert.deepEqual(await answersOf(kit), []);
  });

  it('on a host whose folders teamrig does not know, gives the ship only where the repository sets its worktree folder: it guesses no default (C4)', async () => {
    const unset = await shipKit();
    assert.deepEqual(await unset.kit.run(HOOK, { stdin: call(SHIP), env: ALPHA, mergeGit: unset.git, host: NO_PATHS_HOST }), NOTHING);
    const set = await shipKit({ delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, shipTool: SHIP_TOOL, worktreeFolder: '.claude/worktrees' } } } });
    assert.equal(decisionOf(await set.kit.run(HOOK, { stdin: call(SHIP), env: ALPHA, mergeGit: set.git, host: NO_PATHS_HOST })), 'allow');
  });

  it('gives no ship when the tool has a change, is untracked, sits off main, or in another repository (C5)', async () => {
    const changed = await shipKit();
    changed.git.status.set('/repo/ship', ['?? tools/ship/extra.ts']);
    const untracked = await shipKit();
    untracked.git.blobs.set('base:tools/ship/ship.ts', undefined);
    const behind = await shipKit();
    behind.git.heads.set('/repo/ship', 'mine');
    const elsewhere = await shipKit();
    elsewhere.git.checkouts.set('/repo/ship', { top: '/repo/ship', branch: undefined, mainCheckout: '/repo/other', linked: true });
    for (const [name, { kit, git }] of Object.entries({ changed, untracked, behind, elsewhere })) {
      assert.deepEqual(await kit.run(HOOK, { stdin: call(SHIP), env: ALPHA, mergeGit: git }), NOTHING, name);
    }
  });

  it("gives no ship from a clean checkout detached at an older main commit, only from main's current code (C5, T3223)", async () => {
    const older = await shipKit();
    older.git.heads.set('/repo/ship', 'old');
    older.git.ancestry.add('old>base');
    assert.deepEqual(await older.kit.run(HOOK, { stdin: call(SHIP), env: ALPHA, mergeGit: older.git }), NOTHING, 'a past main, though main holds it');
    const same = await shipKit();
    same.git.heads.set('/repo/ship', 'rebuilt');
    same.git.trees.set('rebuilt', 'tree-base');
    assert.equal(decisionOf(await same.kit.run(HOOK, { stdin: call(SHIP), env: ALPHA, mergeGit: same.git })), 'allow', "another commit that makes main's tree");
  });

  it("gives no ship when git does not answer a read of the tool's checkout (C5 fails closed, T3368)", async () => {
    const { kit, git } = await shipKit();
    git.unanswered.push('git rev-parse in /repo/ship did not answer: stopped by SIGTERM');
    assert.deepEqual(await kit.run(HOOK, { stdin: call(SHIP), env: ALPHA, mergeGit: git }), NOTHING);
  });

  it('gives no ship to a team whose repository names no ship tool', async () => {
    const { kit, git } = await shipKit({ delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT } } } });
    assert.deepEqual(await kit.run(HOOK, { stdin: call(SHIP), env: ALPHA, mergeGit: git }), NOTHING);
  });
});

/** A release merge of T1, alpha's task, from the repository's main checkout (T4672). */
const RELEASE = `teamrig queue --kind merge --detach --what "release" --task T1 --session alpha -- node ${SHIP_TOOL} merge ${MAIN_CHECKOUT} --release T1 --approved 0123456789abcdef0123456789abcdef01234567`;

describe('hook route-allow: the release merge (T4672)', () => {
  it("allows the holder's release merge of its own release task from the main checkout, logging the release", async () => {
    const { kit, git } = await shipKit();
    const result = await kit.run(HOOK, { stdin: call(RELEASE), env: ALPHA, mergeGit: git });
    assert.equal(decisionOf(result), 'allow');
    const [logged] = await answersOf(kit);
    assert.ok(isRecord(logged) && logged['command'] === 'queue merge' && logged['target'] === 'release T1');
  });

  it("gives no release merge of another session's task, another --task, from a worktree, or with a tool off main's code", async () => {
    const { kit, git } = await shipKit();
    assert.equal((await kit.run(['add', '--title', 'Release the API', '--description', 'what and why', '--priority', 'p1', '--owner', 'bravo', '--session', 'lead'])).code, EXIT.ok);
    for (const line of [RELEASE.replaceAll('T1', 'T2'), RELEASE.replace('--task T1', '--task T2'), RELEASE.replace(` ${MAIN_CHECKOUT} `, ` ${SHIP_WORKTREE} `), RELEASE.replace(` ${MAIN_CHECKOUT} `, ' /repo/other ')]) {
      assert.deepEqual(await kit.run(HOOK, { stdin: call(line), env: ALPHA, mergeGit: git }), NOTHING, line);
    }
    const changed = await shipKit();
    changed.git.status.set('/repo/ship', ['?? tools/ship/extra.ts']);
    assert.deepEqual(await changed.kit.run(HOOK, { stdin: call(RELEASE), env: ALPHA, mergeGit: changed.git }), NOTHING, 'a tool with a change (C5)');
    assert.deepEqual(await answersOf(kit), []);
  });
});

describe('hook route-allow: the migrate role (T4606)', () => {
  const ROWS = `${TASKS}/T1/rows.jsonl`;
  const MIGRATE = `teamrig issue migrate ${ROWS} --yes --session alpha`;
  const ROWS_FILE = resolve(TEAM_HOME, 'tasks', 'T1', 'rows.jsonl');
  const migrates = { serviceRoles: { github: { holders: ['alpha'], commands: ['issue close', 'issue migrate'] } } };
  const issueRow = (id: string): string => JSON.stringify({ id, decision: 'issue', repo: 'acme/web', type: 'task', priority: 'p2', title: `Fix ${id.slice(1)}`, body: 'Why.' });

  /** A role team bound to alpha whose rows file holds `issues` issue rows and one local row. */
  async function migrateKit(issues: number, extra: JsonRecord = {}): Promise<CliHarness> {
    const kit = await boundKit({ ...migrates, ...extra });
    const rows = Array.from({ length: issues }, (_, index) => issueRow(`T${index + 2}`));
    await kit.files.write(ROWS_FILE, [...rows, JSON.stringify({ id: 'T99', decision: 'local', reason: 'Names a host.' })].join('\n'));
    return kit;
  }

  it("allows the holder's run on a rows file in a task folder, logging the resolved file and its issue rows", async () => {
    const kit = await migrateKit(2);
    const result = await kit.run(HOOK, { stdin: call(MIGRATE), env: ALPHA });
    assert.equal(decisionOf(result), 'allow');
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(await answersOf(kit), [
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'role', role: 'github', command: 'issue migrate', target: ROWS_FILE, count: 2 },
    ]);
  });

  it('gives no role for a rows file it cannot weigh: missing, or holding a row the run refuses', async () => {
    const kit = await boundKit(migrates);
    assert.deepEqual(await kit.run(HOOK, { stdin: call(MIGRATE), env: ALPHA }), NOTHING, 'missing');
    await kit.files.write(ROWS_FILE, `${issueRow('T2')}\nnot json`);
    assert.deepEqual(await kit.run(HOOK, { stdin: call(MIGRATE), env: ALPHA }), NOTHING, 'a bad row');
    assert.deepEqual(await answersOf(kit), []);
  });

  it('gives no role for a rows file outside the task folders, a preview, or a role without the command', async () => {
    const kit = await migrateKit(1);
    for (const line of [
      `teamrig issue migrate ${TASKS}/rows.jsonl --yes --session alpha`,
      `teamrig issue migrate ${TASKS.replace('/tasks', '/state')}/rows.jsonl --yes --session alpha`,
      `teamrig issue migrate ${TASKS}/T1/../../state/rows.jsonl --yes --session alpha`,
      `teamrig issue migrate ${ROWS} --session alpha`,
    ]) {
      assert.deepEqual(await kit.run(HOOK, { stdin: call(line), env: ALPHA }), NOTHING, line);
    }
    assert.deepEqual(await (await boundKit()).run(HOOK, { stdin: call(MIGRATE), env: ALPHA }), NOTHING, 'a role giving close and comment only');
    assert.deepEqual(await answersOf(kit), []);
  });

  it('counts each issue row of a run toward the daily cap with the closes, refusing a run past the room left (C6)', async () => {
    const kit = await migrateKit(2, { prompts: { serviceRoleDailyCap: 3 } });
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'allow');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(MIGRATE), env: ALPHA })), 'allow', 'one close and two issues fill the cap of 3');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'deny', 'a close past them');
    assert.equal((await answersOf(kit)).length, 2);

    const tight = await migrateKit(3, { prompts: { serviceRoleDailyCap: 3 } });
    assert.equal(decisionOf(await tight.run(HOOK, { stdin: call(CLOSE), env: ALPHA })), 'allow');
    const refused = await tight.run(HOOK, { stdin: call(MIGRATE), env: ALPHA });
    assert.equal(decisionOf(refused), 'deny', 'three issues where two are left');
    assert.match(refused.stdout.join(''), /has less room than this run's 3 issue rows left of its 3 calls/);
    assert.doesNotMatch(refused.stdout.join(''), /split it/);
    assert.equal((await answersOf(tight)).length, 1);

    const big = await migrateKit(4, { prompts: { serviceRoleDailyCap: 3 } });
    assert.match((await big.run(HOOK, { stdin: call(MIGRATE), env: ALPHA })).stdout.join(''), /more issue rows than the cap never runs under the role: split it/, 'a file past the whole cap');
  });
});

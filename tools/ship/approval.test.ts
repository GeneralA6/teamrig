import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EXIT, RefusedError } from '../../src/cli/runtime.ts';
import { mergeStandingOf, type MergeStanding } from '../../src/cli/ship-approval.ts';
import { CLAUDE_SESSION, CliHarness, TEAM_HOME } from '../../src/testing/cli-harness.ts';
import { TempRepo } from '../lib/temp-repo.ts';
import { changePatch, clearMerge, clearMergeFrom, mergeClearance, type MergeReads, shipWritesOf, type StandingOf, type TabCallerOf, taskOfBranch, type WorkCommit, workChanges, workCommitsOf } from './approval.ts';
import { TEAMRIG_RELEASE_STAMPS, TEAMRIG_VERSION_FILES } from './version-bump.ts';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const MANIFEST = 'plugins/teamrig/.claude-plugin/plugin.json';
const VERSION_TS = 'src/core/version.ts';
/** A key a plugin manifest runs commands by, in every session that loads it. */
const HOOKS_KEY = ',\n  "hooks": "./hooks/hooks.json"';
const manifest = (version: string, more = ''): string => `{\n  "name": "teamrig",\n  "version": "${version}",\n  "description": "the kit"${more}\n}\n`;
const versionTs = (version: string): string => `/** The kit's version. */\nexport const KIT_VERSION = '${version}';\n`;
const MIGRATE_TS = 'src/config/migrate.ts';
/** A config migration from `from`, first read by release `release`. */
const migration = (from: number, release: string): string => `export const STEP_${from} = {\n  from: ${from},\n  firstRelease: '${release}',\n};\n`;

/** Team app with T1, alpha's, waiting on the lead's approval; `answer` is the lead's answer, if any. */
async function waitingKit(answer?: readonly string[]): Promise<CliHarness> {
  const kit = new CliHarness();
  assert.equal((await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha'])).code, EXIT.ok);
  assert.equal((await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'branch t1-cli', '--session', 'alpha'])).code, EXIT.ok);
  if (answer !== undefined) {
    const run = await kit.run(['approve', 'T1', ...answer, '--session', 'lead']);
    assert.equal(run.code, EXIT.ok, run.stderr.join('\n'));
  }
  return kit;
}

const standing = async (kit: CliHarness, caller = 'alpha'): Promise<MergeStanding> => mergeStandingOf(kit.runtime(), 'app', caller, 'T1');
const approvedBy = async (note: string): Promise<MergeStanding> => standing(await waitingKit(['--note', note]));
const reasonOf = (clearance: ReturnType<typeof mergeClearance>): string => (clearance.kind === 'refused' ? clearance.reason : `not refused: ${clearance.kind}`);

describe('taskOfBranch', () => {
  it('reads the task from the t<id>- prefix, and none from any other name', () => {
    assert.equal(taskOfBranch('t2788-ship-approval'), 'T2788');
    assert.equal(taskOfBranch('t2693-conflict-hints-r5'), 'T2693');
    assert.equal(taskOfBranch('main'), null);
    assert.equal(taskOfBranch('fix-t12-thing'), null);
    assert.equal(taskOfBranch('t-12-thing'), null);
  });

  it('reads it from a part of the name, as delivery.branches names a branch, the way worktree remove does (T3193)', () => {
    assert.equal(taskOfBranch('fix/t3164-rate-fit-after-a-partial-reset-fits'), 'T3164');
    assert.equal(taskOfBranch('feat/t12-parser'), 'T12');
    assert.equal(taskOfBranch('team/feat/t7-thing'), 'T7');
    assert.equal(taskOfBranch('fix/x-t12-thing'), null);
  });
});

describe('mergeClearance: the merge needs its approver to have approved the head it merges (T2788)', () => {
  it('clears the head the lead approved, by a short or a full sha in its note', async () => {
    assert.deepEqual(mergeClearance(await approvedBy(`head ${HEAD.slice(0, 9)} checked`), 'T1', HEAD, HEAD.slice(0, 9)), { kind: 'approved', by: 'lead' });
    assert.deepEqual(mergeClearance(await approvedBy(`approve ${HEAD}`), 'T1', HEAD, HEAD), { kind: 'approved', by: 'lead' });
  });

  it('refuses a task the register does not hold', async () => {
    const kit = await waitingKit(['--note', HEAD]);
    const clearance = mergeClearance(await mergeStandingOf(kit.runtime(), 'app', 'alpha', 'T9'), 'T9', HEAD, HEAD);
    assert.match(reasonOf(clearance), /holds no task T9/);
  });

  it("refuses a caller merging another session's task, the lead too", async () => {
    const kit = await waitingKit(['--note', HEAD]);
    assert.match(reasonOf(mergeClearance(await standing(kit, 'bravo'), 'T1', HEAD, HEAD)), /T1 is alpha's: only its owner merges it, not bravo/);
    assert.match(reasonOf(mergeClearance(await standing(kit, 'lead'), 'T1', HEAD, null)), /only its owner merges it, not lead/);
  });

  it("clears a root team's lead on its own task with no --approved", async () => {
    const kit = new CliHarness();
    assert.equal((await kit.run(['add', '--title', 'Lead work', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(mergeClearance(await standing(kit, 'lead'), 'T1', HEAD, null), { kind: 'self' });
  });

  it('refuses a merge that names no approved head', async () => {
    assert.match(reasonOf(mergeClearance(await approvedBy(HEAD), 'T1', HEAD, null)), /--approved <sha>: alpha's merge needs the approval of lead/);
  });

  it('refuses --approved that is no sha, or not the branch head', async () => {
    const approved = await approvedBy(HEAD);
    assert.match(reasonOf(mergeClearance(approved, 'T1', HEAD, 'HEAD')), /--approved HEAD is not the branch head/);
    assert.match(reasonOf(mergeClearance(approved, 'T1', HEAD, '0123')), /is not the branch head/, 'too short to name a commit');
    assert.match(reasonOf(mergeClearance(approved, 'T1', HEAD, 'fedcba987')), /--approved fedcba987 is not the branch head/);
  });

  it('refuses a task with no approval: none asked, none given yet, or declined', async () => {
    const asked = new CliHarness();
    assert.equal((await asked.run(['add', '--title', 'Ship', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha'])).code, EXIT.ok);
    assert.match(reasonOf(mergeClearance(await standing(asked), 'T1', HEAD, HEAD)), /T1 \(open\) holds no approval of lead: set it waiting approval:lead/);
    assert.match(reasonOf(mergeClearance(await standing(await waitingKit()), 'T1', HEAD, HEAD)), /T1 \(waiting\) holds no approval of lead/);
    assert.match(reasonOf(mergeClearance(await standing(await waitingKit(['--decline', '--note', HEAD])), 'T1', HEAD, HEAD)), /holds no approval of lead/);
  });

  it('refuses an approval whose note names another head, or no sha', async () => {
    const earlier = 'fedcba9876543210fedcba9876543210fedcba98';
    assert.match(reasonOf(mergeClearance(await approvedBy(`head ${earlier} checked`), 'T1', HEAD, HEAD)), /lead's approval of T1 names no sha of the head/);
    assert.match(reasonOf(mergeClearance(await approvedBy('looks good'), 'T1', HEAD, HEAD)), /names no sha of the head/);
    assert.match(reasonOf(mergeClearance(await approvedBy(`x${HEAD}`), 'T1', HEAD, HEAD)), /names no sha of the head/, 'a sha inside a longer word');
  });
});

describe('clearMerge', () => {
  const caller = { session: 'alpha', team: 'app', claudeSession: CLAUDE_SESSION } as const;
  /** Reads with the tab bound to whichever session the caller names, unless `tabCallerOf` says otherwise. */
  const readsOf = (standingOf: StandingOf, tabCallerOf: TabCallerOf = async (_team, _tab, session) => session): MergeReads => ({ tabCallerOf, standingOf });
  const fixed = (value: MergeStanding): MergeReads => readsOf(async () => value);

  it("reads the tab's session, then its standing for the team and branch task, then clears it", async () => {
    const value = await approvedBy(HEAD);
    const asked: string[][] = [];
    const reads = readsOf(
      async (team, session, taskId) => {
        asked.push(['standing', team, session, taskId]);
        return value;
      },
      async (team, tab, session) => {
        asked.push(['tab', team, tab, session]);
        return 'alpha';
      },
    );
    assert.deepEqual(await clearMerge({ ...caller, session: 'guards' }, reads, 't1-cli', HEAD, HEAD), { kind: 'approved', by: 'lead' });
    assert.deepEqual(asked, [
      ['tab', 'app', CLAUDE_SESSION, 'guards'],
      ['standing', 'app', 'alpha', 'T1'],
    ]);
  });

  it('refuses a branch that names no task, and a caller, team or tab left unset', async () => {
    const value = fixed(await approvedBy(HEAD));
    assert.equal(
      reasonOf(await clearMerge(caller, value, 'cli-fix', HEAD, HEAD)),
      'branch cli-fix names no task: a merged branch is t<id>-<name>, after any type folder (fix/t<id>-<name>)',
      'the refusal names both shapes taskOfBranch reads (GeneralA6/teamrig#1306)',
    );
    assert.match(reasonOf(await clearMerge({ ...caller, session: undefined }, value, 't1-cli', HEAD, HEAD)), /TEAMRIG_SESSION and TEAMRIG_TEAM/);
    assert.match(reasonOf(await clearMerge({ ...caller, team: '' }, value, 't1-cli', HEAD, HEAD)), /TEAMRIG_SESSION and TEAMRIG_TEAM/);
    assert.match(reasonOf(await clearMerge({ ...caller, claudeSession: undefined }, value, 't1-cli', HEAD, HEAD)), /CLAUDE_CODE_SESSION_ID must name the merging Claude Code tab/);
    assert.match(reasonOf(await clearMerge({ ...caller, claudeSession: '' }, value, 't1-cli', HEAD, HEAD)), /CLAUDE_CODE_SESSION_ID/);
  });

  it('clearMergeFrom reads the caller, team and tab from the env, and the marks and register through the reader', async () => {
    const kit = await waitingKit(['--note', HEAD]);
    const marks = join(TEAM_HOME, 'state', 'inbox-marks.jsonl');
    await kit.files.append(marks, `${JSON.stringify({ v: 1, area: 'alpha', line: 0, at: '2030-01-08T09:00:00.000Z', claudeSession: CLAUDE_SESSION, lastLineHash: null })}\n`);
    const env = { TEAMRIG_SESSION: ' alpha ', TEAMRIG_TEAM: 'app', CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION };
    assert.deepEqual(await clearMergeFrom(env, kit.runtime())('t1-cli', HEAD, HEAD), { kind: 'approved', by: 'lead' });
    assert.match(reasonOf(await clearMergeFrom({ ...env, TEAMRIG_SESSION: 'bravo' }, kit.runtime())('t1-cli', HEAD, HEAD)), /this Claude Code tab is not bound to bravo alone/);
    assert.match(reasonOf(await clearMergeFrom({ ...env, TEAMRIG_SESSION: 'stranger' }, kit.runtime())('t1-cli', HEAD, HEAD)), /not bound to stranger alone/);
    assert.match(reasonOf(await clearMergeFrom({ TEAMRIG_TEAM: 'app', CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION }, kit.runtime())('t1-cli', HEAD, HEAD)), /TEAMRIG_SESSION and TEAMRIG_TEAM/);
    assert.match(reasonOf(await clearMergeFrom({ TEAMRIG_SESSION: 'alpha', TEAMRIG_TEAM: 'app' }, kit.runtime())('t1-cli', HEAD, HEAD)), /CLAUDE_CODE_SESSION_ID/);
  });

  it("refuses with the tab's or the register's refusal, and lets any other failure through", async () => {
    const value = await approvedBy(HEAD);
    const refusing = readsOf(async () => {
      throw new RefusedError('stranger is no session of app');
    });
    assert.deepEqual(await clearMerge(caller, refusing, 't1-cli', HEAD, HEAD), { kind: 'refused', reason: 'stranger is no session of app' });
    const unbound = readsOf(
      async () => value,
      async () => {
        throw new RefusedError('this Claude Code tab is not bound to alpha alone');
      },
    );
    assert.deepEqual(await clearMerge(caller, unbound, 't1-cli', HEAD, HEAD), { kind: 'refused', reason: 'this Claude Code tab is not bound to alpha alone' });
    const broken = readsOf(async () => {
      throw new Error('disk gone');
    });
    await assert.rejects(clearMerge(caller, broken, 't1-cli', HEAD, HEAD), /disk gone/);
  });
});

describe('shipWritesOf: how an approval reads the paths a ship writes again (T2914 F1)', () => {
  it('leaves a folder out of the hash and masks a known version file', () => {
    assert.deepEqual(shipWritesOf(['dist/', VERSION_TS], TEAMRIG_VERSION_FILES, TEAMRIG_RELEASE_STAMPS), {
      generated: ['dist/'],
      versionFiles: TEAMRIG_VERSION_FILES.filter((file) => file.path === VERSION_TS),
      releaseStamps: TEAMRIG_RELEASE_STAMPS,
    });
  });

  it('refuses a file that is neither a folder nor a version file the ship rewrites', () => {
    assert.throws(() => shipWritesOf(['dist/', 'src/hooks.json'], TEAMRIG_VERSION_FILES, TEAMRIG_RELEASE_STAMPS), /regenerated path src\/hooks\.json is no folder the build rebuilds and no version file/);
  });
});

describe('changePatch: the fingerprint of what a branch changes over main', () => {
  const WRITES = shipWritesOf(['dist/', MANIFEST, VERSION_TS], TEAMRIG_VERSION_FILES, TEAMRIG_RELEASE_STAMPS);
  let repo: TempRepo;
  const git = (args: readonly string[]): string => repo.git(...args);
  const commitFiles = (subject: string, files: Readonly<Record<string, string>>): string => {
    for (const [path, text] of Object.entries(files)) repo.write(path, text);
    repo.git('add', '--', ...Object.keys(files));
    repo.git('commit', '-q', '-m', subject);
    return repo.git('rev-parse', 'HEAD').trim();
  };
  const raise = (version: string): string => commitFiles(`plugin: version ${version}`, { [MANIFEST]: manifest(version), [VERSION_TS]: versionTs(version) });
  const patch = (rev = 'HEAD'): string => changePatch(git, rev, 'main', WRITES);
  const lines = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join('');

  beforeEach(() => {
    repo = new TempRepo('approval').init();
    repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    commitFiles('base', { 'src/a.ts': lines(1, 20), 'src/b.ts': 'b\n', 'dist/a.js': 'a\n', [MANIFEST]: manifest('0.1.0'), [VERSION_TS]: versionTs('0.1.0'), [MIGRATE_TS]: migration(1, '0.1.0') });
    repo.git('checkout', '-q', '-b', 't1-change');
    commitFiles('core: a', { 'src/a.ts': lines(1, 20).replace('line 15\n', 'line fifteen\n'), 'src/new.ts': 'new\n' });
  });

  afterEach(() => repo.remove());

  it('is a sha256, the same on the same change', () => {
    assert.match(patch(), /^[0-9a-f]{64}$/);
    assert.equal(patch(), patch());
  });

  it('keeps the fingerprint when the branch is rebased over main lines above its own, its version raised and its dist rebuilt', () => {
    const approved = patch();
    repo.git('checkout', '-q', 'main');
    commitFiles('main: more', { 'src/a.ts': `line 0\n${lines(1, 20)}`, 'src/b.ts': 'b2\n', 'dist/a.js': 'a2\n' });
    raise('0.2.0');
    repo.git('checkout', '-q', 't1-change');
    repo.git('rebase', '-q', 'main');
    raise('0.3.0');
    commitFiles('build: dist', { 'dist/a.js': 'a3\n', 'dist/new.js': 'new\n' });
    assert.equal(patch(), approved);
  });

  it('moves the fingerprint on any change to the branch outside its generated folders', () => {
    const approved = patch();
    const sneaked = commitFiles('core: more', { 'src/b.ts': 'b, changed\n' });
    assert.notEqual(patch(sneaked), approved, 'a new file change');
    repo.git('checkout', '-q', '-b', 't1-edited', 'HEAD~1');
    commitFiles('core: a, edited', { 'src/new.ts': 'new, edited\n' });
    assert.notEqual(patch(), approved, 'an edit of a line the approved change made');
  });

  it('moves the fingerprint on an edit to a version file beyond its version, a raise with it too (T2914 F1)', () => {
    raise('0.2.0');
    const approved = patch();
    commitFiles('core: version line', { [VERSION_TS]: `${versionTs('0.2.0')}import './later.ts';\n` });
    assert.notEqual(patch(), approved, 'a line added to version.ts');
    repo.git('checkout', '-q', '-b', 't1-hooks', 'HEAD~1');
    commitFiles('plugin: version 0.3.0', { [MANIFEST]: manifest('0.3.0', HOOKS_KEY), [VERSION_TS]: versionTs('0.3.0') });
    assert.notEqual(patch(), approved, 'a hooks key added to plugin.json in the version raise');
  });

  it('hashes a path git reads as binary by its content (T2914 F2)', () => {
    repo.git('checkout', '-q', 'main');
    commitFiles('main: attributes', { '.gitattributes': 'notes.txt -diff\n' });
    repo.git('checkout', '-q', 't1-change');
    repo.git('rebase', '-q', 'main');
    const base = repo.git('rev-parse', 'HEAD').trim();
    commitFiles('docs: notes', { 'notes.txt': 'one\n', 'src/blob.bin': 'a\u0000b\n' });
    const approved = patch();
    repo.git('checkout', '-q', '-b', 't1-notes', base);
    commitFiles('docs: notes', { 'notes.txt': 'two\n', 'src/blob.bin': 'a\u0000b\n' });
    assert.notEqual(patch(), approved, 'a path .gitattributes marks -diff');
    repo.git('checkout', '-q', '-b', 't1-blob', base);
    commitFiles('docs: notes', { 'notes.txt': 'one\n', 'src/blob.bin': 'a\u0000c\n' });
    assert.notEqual(patch(), approved, 'a binary file');
  });

  /**
   * A change that adds config migration 2, stamped with the version it ships in, approved at its raise to 0.2.0; then
   * main takes 0.2.0, and the same change is made again on it, its raise and stamp set to 0.3.0 (T3419).
   */
  function stampedAgain(): string {
    commitFiles('config: migration 2', { [MIGRATE_TS]: `${migration(1, '0.1.0')}${migration(2, '0.2.0')}` });
    raise('0.2.0');
    const approved = repo.git('rev-parse', 'HEAD').trim();
    repo.git('checkout', '-q', 'main');
    raise('0.2.0');
    repo.git('checkout', '-q', '-b', 't1-again');
    commitFiles('core: a', { 'src/a.ts': lines(1, 20).replace('line 15\n', 'line fifteen\n'), 'src/new.ts': 'new\n' });
    commitFiles('config: migration 2', { [MIGRATE_TS]: `${migration(1, '0.1.0')}${migration(2, '0.3.0')}` });
    raise('0.3.0');
    return approved;
  }

  it("keeps the fingerprint and each patch id when a migration's release stamp is set again with the raise on a newer main (T3419)", () => {
    const approved = stampedAgain();
    assert.equal(patch(), patch(approved));
    assert.deepEqual(workChanges(workCommitsOf(git, approved, 'main', WRITES), workCommitsOf(git, 'HEAD', 'main', WRITES)), []);
  });

  it("moves the fingerprint on an edit to an existing migration's stamp, or to a line of the added migration beside its stamp (T3419)", () => {
    const approved = stampedAgain();
    const restamped = commitFiles('config: restamp 1', { [MIGRATE_TS]: `${migration(1, '0.3.0')}${migration(2, '0.3.0')}` });
    assert.notEqual(patch(restamped), patch(approved), 'an existing stamp');
    repo.git('checkout', '-q', '-b', 't1-from', 'HEAD~1');
    commitFiles('config: migration 2 from 3', { [MIGRATE_TS]: `${migration(1, '0.1.0')}${migration(2, '0.3.0').replace('from: 2', 'from: 3')}` });
    assert.notEqual(patch(), patch(approved), 'a line beside the stamp');
  });

  it('keeps the fingerprint of a head whose raise is not committed yet, its stamp the next release, made again on a newer main (T3419)', () => {
    commitFiles('config: migration 2', { [MIGRATE_TS]: `${migration(1, '0.1.0')}${migration(2, '0.2.0')}` });
    const approved = repo.git('rev-parse', 'HEAD').trim();
    repo.git('checkout', '-q', 'main');
    raise('0.2.0');
    repo.git('checkout', '-q', '-b', 't1-again');
    commitFiles('core: a', { 'src/a.ts': lines(1, 20).replace('line 15\n', 'line fifteen\n'), 'src/new.ts': 'new\n' });
    commitFiles('config: migration 2', { [MIGRATE_TS]: `${migration(1, '0.1.0')}${migration(2, '0.3.0')}` });
    raise('0.3.0');
    assert.equal(patch(), patch(approved));
    assert.deepEqual(workChanges(workCommitsOf(git, approved, 'main', WRITES), workCommitsOf(git, 'HEAD', 'main', WRITES)), []);
  });

  it('moves the fingerprint and the patch id on an added stamp of a version the change does not ship in (T3419)', () => {
    const approved = stampedAgain();
    repo.git('checkout', '-q', '-b', 't1-high', 'HEAD~2');
    commitFiles('config: migration 2', { [MIGRATE_TS]: `${migration(1, '0.1.0')}${migration(2, '0.9.0')}` });
    raise('0.3.0');
    assert.notEqual(patch(), patch(approved), 'a stamp above the raise');
    assert.notDeepEqual(workChanges(workCommitsOf(git, approved, 'main', WRITES), workCommitsOf(git, 'HEAD', 'main', WRITES)), []);
    repo.git('checkout', '-q', '-b', 't1-unraised', 'HEAD~2');
    const next = commitFiles('config: migration 2', { [MIGRATE_TS]: `${migration(1, '0.1.0')}${migration(2, '0.3.0')}` });
    repo.git('checkout', '-q', '-b', 't1-far', 'HEAD~1');
    const far = commitFiles('config: migration 2', { [MIGRATE_TS]: `${migration(1, '0.1.0')}${migration(2, '0.5.0')}` });
    assert.notEqual(patch(far), patch(next), 'a head with no raise committed, stamped past the next release');
  });

  it('gives an existing stamp edited to two different versions two fingerprints (T3419)', () => {
    stampedAgain();
    const head = repo.git('rev-parse', 'HEAD').trim();
    const shipped = commitFiles('config: restamp 1', { [MIGRATE_TS]: `${migration(1, '0.3.0')}${migration(2, '0.3.0')}` });
    repo.git('checkout', '-q', '-b', 't1-other', head);
    const other = commitFiles('config: restamp 1', { [MIGRATE_TS]: `${migration(1, '0.4.0')}${migration(2, '0.3.0')}` });
    assert.notEqual(patch(other), patch(shipped));
  });

  it('reads the change from the merge base, so commits main gains after the fork never count', () => {
    const approved = patch();
    repo.git('checkout', '-q', 'main');
    commitFiles('main: other', { 'src/c.ts': 'c\n' });
    repo.git('checkout', '-q', 't1-change');
    assert.equal(patch(), approved);
  });

  describe('workCommitsOf: the commits a branch carries, with their patch ids (T2913)', () => {
    const work = (rev = 'HEAD'): WorkCommit[] => workCommitsOf(git, rev, 'main', WRITES);

    it('lists the work commits oldest first, and leaves out a version raise and a dist rebuild', () => {
      commitFiles('docs: b', { 'src/b.ts': 'b, documented\n' });
      raise('0.2.0');
      commitFiles('build: dist', { 'dist/a.js': 'a2\n' });
      assert.deepEqual(work().map(({ subject, merge }) => ({ subject, merge })), [{ subject: 'core: a', merge: false }, { subject: 'docs: b', merge: false }]);
      assert.match(work()[0]?.patch ?? '', /^[0-9a-f]{64}$/);
    });

    it('keeps every patch id over a rebase onto main lines away from its own, so the two heads compare equal', () => {
      commitFiles('docs: b', { 'src/b.ts': 'b, documented\n' });
      raise('0.2.0');
      const approved = repo.git('rev-parse', 'HEAD').trim();
      repo.git('checkout', '-q', 'main');
      commitFiles('main: more', { 'src/a.ts': `line 0\n${lines(1, 20)}`, 'dist/a.js': 'a2\n' });
      raise('0.2.0');
      repo.git('checkout', '-q', 't1-change');
      repo.git('rebase', '-q', 'main');
      raise('0.3.0');
      assert.notEqual(repo.git('rev-parse', 'HEAD').trim(), approved);
      assert.deepEqual(workChanges(work(approved), work()), []);
    });

    it('counts a commit that adds a line to version.ts or a hooks key to plugin.json as work, so it refuses (T2914 F1)', () => {
      raise('0.2.0');
      const approved = repo.git('rev-parse', 'HEAD').trim();
      const line = commitFiles('plugin: version 0.2.0', { [VERSION_TS]: `${versionTs('0.2.0')}import './later.ts';\n` });
      assert.deepEqual(workChanges(work(approved), work()), [`added ${line.slice(0, 9)} "plugin: version 0.2.0"`]);
      repo.git('checkout', '-q', '-b', 't1-hooks', approved);
      const hooks = commitFiles('plugin: version 0.3.0', { [MANIFEST]: manifest('0.3.0', HOOKS_KEY), [VERSION_TS]: versionTs('0.3.0') });
      assert.deepEqual(workChanges(work(approved), work()), [`added ${hooks.slice(0, 9)} "plugin: version 0.3.0"`]);
    });

    it('tells apart two contents of a path git reads as binary (T2914 F2)', () => {
      const base = repo.git('rev-parse', 'HEAD').trim();
      commitFiles('docs: notes', { '.gitattributes': 'notes.txt -diff\n', 'notes.txt': 'one\n' });
      const approved = repo.git('rev-parse', 'HEAD').trim();
      repo.git('checkout', '-q', '-b', 't1-notes', base);
      const swapped = commitFiles('docs: notes', { '.gitattributes': 'notes.txt -diff\n', 'notes.txt': 'two\n' });
      assert.deepEqual(workChanges(work(approved), work()), [`changed ${approved.slice(0, 9)} "docs: notes", now ${swapped.slice(0, 9)}`]);
    });

    it('moves the patch id of a commit whose own lines or context changed', () => {
      const approved = repo.git('rev-parse', 'HEAD').trim();
      repo.git('checkout', '-q', 'main');
      commitFiles('main: near', { 'src/a.ts': lines(1, 20).replace('line 12\n', 'line twelve\n') });
      repo.git('checkout', '-q', 't1-change');
      repo.git('rebase', '-q', 'main');
      assert.deepEqual(workChanges(work(approved), work()), [`changed ${approved.slice(0, 9)} "core: a", now ${repo.git('rev-parse', 'HEAD').trim().slice(0, 9)}`]);
    });

    it('lists a merge commit as one, with no patch', () => {
      repo.git('checkout', '-q', '-b', 'side', 'main');
      commitFiles('side: c', { 'src/c.ts': 'c\n' });
      repo.git('checkout', '-q', 't1-change');
      repo.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const listed = work().map(({ subject, merge, patch: id }) => ({ subject, merge, empty: id === '' }));
      assert.deepEqual(listed.toSorted((a, b) => a.subject.localeCompare(b.subject)), [
        { subject: 'core: a', merge: false, empty: false },
        { subject: 'merge side', merge: true, empty: true },
        { subject: 'side: c', merge: false, empty: false },
      ]);
    });
  });
});

describe('workChanges: how a head differs from the approved one, commit for commit (T2913)', () => {
  const commit = (sha: string, subject: string, patch: string, merge = false): WorkCommit => ({ sha, subject, merge, patch });
  const A = commit('aaaaaaaaaa', 'core: a', 'pa');
  const B = commit('bbbbbbbbbb', 'docs: b', 'pb');

  it('finds none when the patches match in order, whatever the shas', () => {
    assert.deepEqual(workChanges([A, B], [commit('a2', 'core: a', 'pa'), commit('b2', 'docs: b', 'pb')]), []);
    assert.deepEqual(workChanges([], []), []);
  });

  it('names a changed commit by its subject, a dropped and an added one', () => {
    assert.deepEqual(workChanges([A, B], [commit('a222222222', 'core: a', 'pa2'), B]), ['changed aaaaaaaaa "core: a", now a22222222']);
    assert.deepEqual(workChanges([A, B], [A]), ['dropped bbbbbbbbb "docs: b"']);
    assert.deepEqual(workChanges([A], [A, B]), ['added bbbbbbbbb "docs: b"']);
  });

  it('names a reorder and any merge commit on either side', () => {
    assert.deepEqual(workChanges([A, B], [B, A]), ['reordered, now bbbbbbbbb, aaaaaaaaa']);
    const merge = commit('mmmmmmmmmm', 'merge main', '', true);
    assert.deepEqual(workChanges([A], [A, merge]), ['merge commit mmmmmmmmm "merge main": rebase it away']);
    assert.deepEqual(workChanges([A, merge], [A]), ['merge commit mmmmmmmmm "merge main": rebase it away']);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMergeGit, MAIN_CHECKOUT, WORKTREE } from '../testing/fake-merge-git.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { decisionRecordHold, type DecisionRecordChange } from './decision-records.ts';

const TASKS = '/team/tasks';
const CHANGE: DecisionRecordChange = { repo: 'app', docsFolder: undefined, top: WORKTREE, mainCheckout: MAIN_CHECKOUT, branch: 't5-docs', onto: 'origin/main', tasksFolder: TASKS };
const NOTE = { [`${TASKS}/T5/design.md`]: '# T5 design\n' };
const RECORD = 'docs/decisions/2030-01-08-merge-gate.md';

/** A branch checkout whose HEAD (`mine`) holds `paths` as files and changes `changed` against the merge base. */
function gitWith(changed: readonly string[] | undefined, held: readonly string[] = changed ?? []): FakeMergeGit {
  const git = new FakeMergeGit();
  git.paths = changed;
  for (const path of held) {
    git.files.set(`mine:${path}`, '# Record\n');
  }
  return git;
}

function hold(change: DecisionRecordChange, git: FakeMergeGit, files: MemoryFiles, platform: NodeJS.Platform = 'linux'): Promise<string | undefined> {
  return decisionRecordHold(change, { git, files, platform });
}

describe('decisionRecordHold', () => {
  it('lets through a branch named for no task, and a task with no design note in its folder', async () => {
    const git = gitWith(['src/app.ts']);
    assert.equal(await hold({ ...CHANGE, branch: 'feat' }, git, new MemoryFiles(NOTE)), undefined);
    assert.equal(await hold(CHANGE, git, new MemoryFiles({ [`${TASKS}/T5/plan.md`]: 'plan', [`${TASKS}/T5/designer.md`]: 'not a design note' })), undefined);
    assert.equal(await hold(CHANGE, git, new MemoryFiles()), undefined, 'a task with no folder');
  });

  it('lets through a task with a design note when the branch adds a record in docs/decisions/', async () => {
    assert.equal(await hold(CHANGE, gitWith(['src/app.ts', RECORD]), new MemoryFiles(NOTE)), undefined);
  });

  it('refuses a task with a design note when the branch adds no record, naming the note, the folder and the setting', async () => {
    const reason = await hold(CHANGE, gitWith(['src/app.ts', 'docs/how-it-works.md']), new MemoryFiles(NOTE));
    assert.equal(
      reason,
      'T5 has a design note (design.md) and t5-docs adds or changes no decision record in docs/decisions/: write the decided design there as a record ' +
        '(docs/decisions/YYYY-MM-DD-<slug>.md, in the format the teamrig merge guide gives) and commit it on the branch; ' +
        'delivery.repos.app.decisionRecordGate holds a task with a design note until its record lands',
    );
  });

  const notes: readonly { readonly name: string; readonly counts: boolean }[] = [
    { name: 'design.md', counts: true },
    { name: 'Design.MD', counts: true },
    { name: 'design-v2.md', counts: true },
    { name: 'pr2-design.md', counts: true },
    { name: 'T5_design.md', counts: true },
    { name: 'designer.md', counts: false },
    { name: 'redesign.md', counts: false },
    { name: 'design.md.bak', counts: false },
    { name: 'design.txt', counts: false },
  ];
  for (const { name, counts } of notes) {
    it(`${counts ? 'holds' : 'ignores'} a task folder file named ${name}`, async () => {
      const reason = await hold(CHANGE, gitWith(['src/app.ts']), new MemoryFiles({ [`${TASKS}/T5/${name}`]: 'note' }));
      assert.equal(reason !== undefined, counts, reason);
    });
  }

  it('names every design note, in order', async () => {
    const files = new MemoryFiles({ [`${TASKS}/T5/pr2-design.md`]: 'b', [`${TASKS}/T5/design.md`]: 'a' });
    assert.match((await hold(CHANGE, gitWith(['src/app.ts']), files)) ?? '', /^T5 has a design note \(design\.md, pr2-design\.md\)/);
  });

  it('refuses a branch that only deletes a record, or only changes the decisions folder index', async () => {
    assert.match((await hold(CHANGE, gitWith([RECORD], []), new MemoryFiles(NOTE))) ?? '', /adds or changes no decision record/);
    assert.match((await hold(CHANGE, gitWith(['docs/decisions/README.md']), new MemoryFiles(NOTE))) ?? '', /adds or changes no decision record/);
    assert.match((await hold(CHANGE, gitWith(['docs/decisions-old/x.md']), new MemoryFiles(NOTE))) ?? '', /adds or changes no decision record/);
  });

  it('finds the records in a docs folder set relative to the repository, or as an absolute path in the main checkout', async () => {
    const files = new MemoryFiles(NOTE);
    const nested = 'notes/docs/decisions/2030-01-08-gate.md';
    assert.equal(await hold({ ...CHANGE, docsFolder: 'notes/docs' }, gitWith([nested]), files), undefined);
    assert.equal(await hold({ ...CHANGE, docsFolder: `${MAIN_CHECKOUT}/notes/docs/` }, gitWith([nested]), files), undefined);
    assert.match((await hold({ ...CHANGE, docsFolder: 'notes/docs' }, gitWith([RECORD]), files)) ?? '', /no decision record in notes\/docs\/decisions\//);
    assert.equal(await hold({ ...CHANGE, docsFolder: '.' }, gitWith(['decisions/2030-01-08-gate.md']), files), undefined);
  });

  it('reads a Windows docs folder in the checkout in any case', async () => {
    const change = { ...CHANGE, top: 'C:\\w\\t5-docs', mainCheckout: 'C:\\repo\\app', docsFolder: 'c:/REPO/app/Docs', tasksFolder: 'C:\\team\\tasks' };
    const git = gitWith(['Docs/decisions/2030-01-08-gate.md']);
    git.heads.set(change.top, 'mine');
    assert.equal(await hold(change, git, new MemoryFiles({ 'C:\\team\\tasks\\T5\\design.md': 'note' }), 'win32'), undefined);
  });

  it('refuses when it cannot read what the branch changes', async () => {
    const files = new MemoryFiles(NOTE);
    assert.equal(
      await hold(CHANGE, gitWith(undefined), files),
      'could not read what t5-docs changes against origin/main, so the decision record gate cannot clear it',
    );
    const git = gitWith([RECORD]);
    git.mergeBaseIs = undefined;
    assert.match((await hold(CHANGE, git, files)) ?? '', /decision record gate cannot clear it/);
  });

  describe('with the docs folder outside the repository', () => {
    const OUTSIDE = { ...CHANGE, docsFolder: '/srv/docs-site' };

    it('lets the branch through once a record there names the task, whatever the branch changes', async () => {
      const files = new MemoryFiles({ ...NOTE, '/srv/docs-site/decisions/2030-01-08-gate.md': '# Gate\n\nTrace: T5\n' });
      assert.equal(await hold(OUTSIDE, gitWith(['src/app.ts']), files), undefined);
    });

    it('refuses while no record names the task: a longer id, or only the index, does not count', async () => {
      const files = new MemoryFiles({
        ...NOTE,
        '/srv/docs-site/decisions/2030-01-08-other.md': 'Trace: T55, T5a\n',
        '/srv/docs-site/decisions/README.md': 'T5 is next\n',
      });
      assert.equal(
        await hold(OUTSIDE, gitWith(['src/app.ts']), files),
        'T5 has a design note (design.md) and no decision record in /srv/docs-site/decisions names it: write the decided design there as a record that names T5 ' +
          '(YYYY-MM-DD-<slug>.md, in the format the teamrig merge guide gives); delivery.repos.app.decisionRecordGate holds a task with a design note until its record lands',
      );
    });

    it('reads a relative docs folder that leads out of the repository as outside it', async () => {
      const files = new MemoryFiles({ ...NOTE, '/w/site/decisions/2030-01-08-gate.md': 'T5' });
      assert.equal(await hold({ ...CHANGE, docsFolder: '../site' }, gitWith(['src/app.ts']), files), undefined);
    });
  });
});

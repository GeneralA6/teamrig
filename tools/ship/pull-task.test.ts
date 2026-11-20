import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Gh } from './github.ts';
import { type PullFacts, type PullTask, facePull, labelPull, pullFaceOf, pullLabels, unlinkedReason, withCloses } from './pull-task.ts';

const REPO = 'teamrig/teamrig';
const HEAD = 'feat/t42-ship-titles';
const ISSUE = { repo: REPO, number: 1900 };
const REPO_LABELS = ['p0', 'p1', 'P2', 'bug', 'task', 'feature', 'enhancement', 'design', 'area:cli', 'area:github', 'status:agreed'];
const task = (overrides: Partial<PullTask> = {}): PullTask => ({ id: 'T42', priority: 1, type: null, ref: `gh:${REPO}#1900`, ...overrides });
const facts = (overrides: Partial<PullFacts> = {}): PullFacts => ({
  repo: REPO,
  head: HEAD,
  subjects: ['feat(ship): titles from the task (T42)', 'build: rebuild the plugin dist'],
  note: '## What\n\nTitles.',
  task: task(),
  issue: { title: 'Pull requests carry their issue', labels: ['enhancement', 'p0', 'status:agreed', 'area:cli', 'Design'] },
  repoLabels: REPO_LABELS,
  ...overrides,
});

test('a task with its issue opens as T<n>: <issue title>, closes the issue and takes the labels the repo has (T4796)', () => {
  assert.deepEqual(facePull(facts()), {
    title: 'T42: Pull requests carry their issue',
    note: '## What\n\nTitles.\n\nCloses #1900',
    labels: ['p1', 'enhancement', 'area:cli', 'design'],
    unlinked: null,
  });
});

test("the issue's own priority and status labels are dropped: the task's priority says it again (T4796)", () => {
  assert.deepEqual(pullLabels(task({ priority: 2 }), { title: 'x', labels: ['p0', 'blocker', 'status:agreed', 'area:github'] }, REPO_LABELS), ['P2', 'task', 'area:github']);
});

test('a bug task is labelled bug, and a label the repo lacks is left out, never created (T4796)', () => {
  assert.deepEqual(pullLabels(task({ type: 'bug', priority: 3 }), { title: 'x', labels: ['area:docs'] }, REPO_LABELS), ['bug']);
  assert.deepEqual(pullLabels(task(), null, []), []);
});

test('an issue in another repo is closed by its full name (T4796)', () => {
  assert.equal(withCloses(null, { repo: 'teamrig/teamrig-pane', number: 7 }, REPO), 'Closes teamrig/teamrig-pane#7');
});

test('a note that already closes, fixes or resolves the issue gets no second line (T4796)', () => {
  assert.equal(withCloses('Fixes #1900.', ISSUE, REPO), 'Fixes #1900.');
  assert.equal(withCloses('resolves Teamrig/Teamrig#1900', ISSUE, REPO), 'resolves Teamrig/Teamrig#1900');
  assert.equal(withCloses('Closes #19001', ISSUE, REPO), 'Closes #19001\n\nCloses #1900');
});

test('an unread issue leaves the title to the first commit subject, still closing it (T4796)', () => {
  const face = facePull(facts({ issue: null }));
  assert.equal(face.title, 'T42: feat(ship): titles from the task (T42)');
  assert.match(face.note ?? '', /Closes #1900$/);
});

test('a task kept off GitHub is titled by its first commit and closes nothing, never naming its reason (T4796)', () => {
  assert.deepEqual(facePull(facts({ task: task({ ref: 'local: hardening detail' }), issue: null })), {
    title: 'feat(ship): titles from the task (T42)',
    note: '## What\n\nTitles.',
    labels: ['p1', 'task'],
    unlinked: null,
  });
});

test('a task with no ref, or a branch with no task, opens no pull request: the reason gives the fix (T4796)', () => {
  assert.match(facePull(facts({ task: task({ ref: null }) })).unlinked ?? '', /^T42 links no GitHub issue.*teamrig update T42 --ref gh:<owner\/name>#<n>/);
  assert.match(unlinkedReason(HEAD, undefined), /^the register holds no task T42/);
  assert.match(unlinkedReason('dev', undefined), /^dev names no task/);
});

test('pullFaceOf reads the issue and the repo labels; a failed read is a warning line, not a failure (T4796)', () => {
  const gh = mock.fn<Gh>(args => {
    if (args[1] === `repos/${REPO}/issues/1900`) return JSON.stringify({ title: 'Pull requests carry their issue', labels: [{ name: 'area:cli' }] });
    throw new Error('HTTP 403');
  });
  const warned: string[] = [];
  const face = pullFaceOf(gh, { repo: REPO, head: HEAD, subjects: ['a'], note: null, task: task() }, line => warned.push(line));
  assert.deepEqual(face, { title: 'T42: Pull requests carry their issue', note: 'Closes #1900', labels: [], unlinked: null });
  assert.deepEqual(gh.mock.calls.map(call => call.arguments[0][1]), [`repos/${REPO}/issues/1900`, `repos/${REPO}/labels?per_page=100`]);
  assert.match(warned.join('\n'), /^warning: the labels of teamrig\/teamrig were not read \(HTTP 403\)/);
});

test('pullFaceOf reads nothing for a task with no issue (T4796)', () => {
  const gh = mock.fn<Gh>(() => '[]');
  const warned: string[] = [];
  assert.equal(pullFaceOf(gh, { repo: REPO, head: HEAD, subjects: ['a'], note: null, task: task({ ref: null }) }, line => warned.push(line)).title, 'a');
  assert.equal(gh.mock.callCount(), 0);
  pullFaceOf(gh, { repo: REPO, head: HEAD, subjects: ['a'], note: null, task: task({ ref: 'local: x' }) }, line => warned.push(line));
  assert.deepEqual(gh.mock.calls.map(call => call.arguments[0][1]), [`repos/${REPO}/labels?per_page=100`]);
  assert.deepEqual(warned, ['T42 is kept off GitHub: its pull request is titled by its first commit and closes no issue']);
});

test('labelPull adds the labels in one call, and a refused write is a warning line (T4796)', () => {
  const gh = mock.fn<Gh>(() => '[]');
  const lines: string[] = [];
  labelPull(gh, REPO, 3, ['p1', 'area:cli'], line => lines.push(line));
  labelPull(gh, REPO, 3, [], line => lines.push(line));
  assert.deepEqual(gh.mock.calls.map(call => call.arguments[0]), [['api', `repos/${REPO}/issues/3/labels`, '-X', 'POST', '-f', 'labels[]=p1', '-f', 'labels[]=area:cli']]);
  const refused = mock.fn<Gh>(() => {
    throw new Error('HTTP 403');
  });
  labelPull(refused, REPO, 3, ['p1'], line => lines.push(line));
  assert.deepEqual(lines, ['labelled pull request #3: p1, area:cli', 'warning: pull request #3 was not labelled p1 (HTTP 403): add them by hand']);
});

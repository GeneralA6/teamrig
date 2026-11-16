import { readSubject, shortSha } from '../subject.ts';
import type { ChangeEntry, ChangeKind, ChangeSource, GitCommit, RegisterTask } from '../source.ts';
import { pathsOf, readFailure } from './shared.ts';

/** `gh:owner/name#12` as a reader looks it up: `#12`. Any other ref is kept as the register holds it. */
function refOf(ref: string): string {
  return /#\d+$/.exec(ref)?.[0] ?? ref;
}

/** A bug is a fix; a task is a feature when one of its commits is, else it keeps the kind its commits agree on. */
function kindOf(task: RegisterTask, kinds: readonly ChangeKind[]): ChangeKind {
  if (kinds.includes('behaviour')) {
    return 'behaviour';
  }
  if (task.type === 'bug') {
    return 'fix';
  }
  return kinds.includes('feature') ? 'feature' : kinds.includes('fix') ? 'fix' : 'other';
}

/** One task's entry from the commits naming it, newest first: its title, the area of its first user-facing commit, the files they touched but a release commit. */
function entryOf(task: RegisterTask, commits: readonly GitCommit[]): ChangeEntry {
  const reads = commits.map((commit) => readSubject(commit.subject, commit.body));
  const shown = reads.filter((read) => !read.hidden);
  const first = shown.at(-1) ?? reads.at(-1);
  return {
    source: 'register',
    version: undefined,
    at: commits[0]?.at,
    area: first?.area ?? 'general',
    kind: kindOf(task, shown.map((read) => read.kind)),
    audience: 'lead',
    text: task.title,
    action: undefined,
    files: [...new Set(commits.filter((_, index) => reads[index]?.release !== true).flatMap((commit) => commit.files))],
    refs: [task.id, ...(task.ref === undefined ? [] : [refOf(task.ref)]), ...commits.map((commit) => shortSha(commit.sha)), ...new Set(reads.flatMap((read) => read.numbers))],
  };
}

/**
 * The team's tasks the range's commits name (`T12` in a subject): one entry per task, its title as the text, its
 * type and its commits' prefixes setting the kind, the files its commits touched but its release commit. A project with a
 * team reads its own register; a commit naming no task is left to the git source.
 */
export const REGISTER_SOURCE: ChangeSource = {
  id: 'register',
  capabilities: { byVersion: true, byDate: true, byFile: true, byArea: false, classified: false },
  detect: async ({ register }) => register !== undefined,
  read: async ({ git, project, register }, query) => {
    if (register === undefined) {
      return { kind: 'read', entries: [], warnings: [] };
    }
    try {
      const commits = await git.log(project, { since: query.since, until: query.until, paths: pathsOf(query) });
      const byTask = new Map<string, GitCommit[]>();
      for (const commit of commits) {
        for (const id of readSubject(commit.subject).taskIds) {
          byTask.set(id, [...(byTask.get(id) ?? []), commit]);
        }
      }
      const tasks = await register.tasks([...byTask.keys()]);
      const entries = tasks.map((task) => entryOf(task, byTask.get(task.id) ?? []));
      return { kind: 'read', entries, warnings: [] };
    } catch (error) {
      return readFailure(error);
    }
  },
};

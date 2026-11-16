import type { ChangeGit, ChangeSourceDeps, GitCommit, RegisterTask, Release, ResolvedPoint, TaskReader } from '../changes/source.ts';
import { TokenMissingError } from '../github/tokens.ts';
import { FakeGh } from './fake-gh.ts';
import { MemoryFiles } from './memory-files.ts';

/** A commit for a spec: `files` and `body` default to none. */
export function commitOf(sha: string, at: string, subject: string, files: readonly string[] = [], body: string = ''): GitCommit {
  return { sha, at, subject, body, files };
}

/**
 * A project's history in memory: `commits` newest first, as git logs them, and its release index. A range by commit
 * takes the commits newer than its `since` commit up to its `until` one; a range by time compares each commit's time.
 * Every read is recorded, so a spec sees which range a source asked for.
 */
export class FakeChangeGit implements ChangeGit {
  readonly logs: { readonly project: string; readonly since: ResolvedPoint; readonly until: ResolvedPoint | undefined; readonly paths: readonly string[] }[] = [];
  /** Set to make every read reject, as git does in a folder that is no repository. */
  failure: string | undefined;

  private readonly commits: readonly GitCommit[];
  private readonly index: readonly Release[];

  constructor(commits: readonly GitCommit[] = [], index: readonly Release[] = []) {
    this.commits = commits;
    this.index = index;
  }

  async log(project: string, range: { readonly since: ResolvedPoint; readonly until: ResolvedPoint | undefined; readonly paths: readonly string[] }): Promise<readonly GitCommit[]> {
    this.logs.push({ project, ...range });
    this.fail();
    const { since, until, paths } = range;
    const upTo = until?.ref === undefined ? 0 : this.positionOf(until.ref);
    const after = since.ref === undefined ? this.commits.length : this.positionOf(since.ref);
    return this.commits
      .slice(upTo, after)
      .filter((commit) => since.ref !== undefined || since.at === undefined || commit.at > since.at)
      .filter((commit) => until?.ref !== undefined || until?.at === undefined || commit.at <= until.at)
      .filter((commit) => paths.length === 0 || commit.files.some((file) => paths.some((path) => file.startsWith(path))));
  }

  async releases(): Promise<readonly Release[]> {
    this.fail();
    return this.index;
  }

  private positionOf(sha: string): number {
    const position = this.commits.findIndex((commit) => commit.sha === sha);
    if (position === -1) {
      throw new Error(`fatal: bad revision '${sha}'`);
    }
    return position;
  }

  private fail(): void {
    if (this.failure !== undefined) {
      throw new Error(this.failure);
    }
  }
}

/** A register holding these tasks. */
export function taskReaderOf(tasks: readonly RegisterTask[]): TaskReader {
  return { tasks: async (ids) => tasks.filter((task) => ids.includes(task.id)) };
}

/** A task for a spec: a task with no ref unless given. */
export function registerTaskOf(id: string, title: string, fields: Partial<Pick<RegisterTask, 'type' | 'ref'>> = {}): RegisterTask {
  return { id, title, type: fields.type ?? 'task', ref: fields.ref };
}

/** The project every spec's sources read, unless one gives its own. */
export const CHANGE_PROJECT = '/work/app';

/**
 * A source's deps for a spec: empty files, a history with no commits, a gh that sees nothing, no saved key and no
 * register at `/work/app`, each replaced by what the spec gives.
 */
export function changeDepsOf(overrides: Partial<ChangeSourceDeps> = {}): ChangeSourceDeps {
  return {
    files: new MemoryFiles(),
    git: new FakeChangeGit(),
    gh: new FakeGh(),
    access: async (repo) => new TokenMissingError(repo.split('/')[0] ?? repo, 'spec-credential', 'the spec store', 'save-key'),
    project: CHANGE_PROJECT,
    register: undefined,
    ...overrides,
  };
}

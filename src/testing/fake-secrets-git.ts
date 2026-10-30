import type { CommitAdds, PatchAdds, TagMessage } from '../secret-guard/git-adds.ts';
import { rangeArgs, type PushRange } from '../secret-guard/push-range.ts';
import type { SecretsGit } from '../secret-guard/secrets-git.ts';

/**
 * A repository for `teamrig secrets`, in memory, with its top folder at `top` (undefined: no repository). Its index adds `index` (undefined: git
 * cannot read it); it holds the commits in `known`; the log of a range lists `logs` under its `git log` arguments joined
 * by spaces (none when not listed), unless `logFails`. Each range read is kept in `read`, as that key. The annotated
 * tags an id names are its entry in `tags` (none: a commit), unless `tagFails`. The hooks folder of a repository
 * folder is its entry in `hookDirs` (none: git reads no repository there).
 */
export class FakeSecretsGit implements SecretsGit {
  index: PatchAdds | undefined = { paths: [], lines: [] };
  readonly known = new Set<string>();
  readonly logs = new Map<string, readonly CommitAdds[]>();
  readonly tags = new Map<string, readonly TagMessage[]>();
  readonly hookDirs = new Map<string, string>();
  readonly read: string[] = [];
  logFails = false;
  tagFails = false;
  private readonly top: string | undefined;

  constructor(top: string | undefined) {
    this.top = top;
  }

  root(): string | undefined {
    return this.top;
  }

  staged(): PatchAdds | undefined {
    return this.index;
  }

  isCommit(_dir: string, sha: string): boolean {
    return this.known.has(sha);
  }

  commits(_dir: string, range: PushRange): CommitAdds[] | undefined {
    const key = rangeArgs(range).join(' ');
    this.read.push(key);
    return this.logFails ? undefined : [...(this.logs.get(key) ?? [])];
  }

  tagMessages(_dir: string, sha: string): TagMessage[] | undefined {
    return this.tagFails ? undefined : [...(this.tags.get(sha) ?? [])];
  }

  hooksDir(dir: string): string | undefined {
    return this.hookDirs.get(dir);
  }
}

import type { CommitAdds, PatchAdds } from '../secret-guard/git-adds.ts';
import { rangeArgs, type PushRange } from '../secret-guard/push-range.ts';
import type { SecretsGit } from '../secret-guard/secrets-git.ts';

/**
 * A repository for `teamrig secrets`, in memory, with its top folder at `top`. Its index adds `index` (undefined: git
 * cannot read it); it holds the commits in `known`; the log of a range lists `logs` under its `git log` arguments joined
 * by spaces (none when not listed), unless `logFails`. Each range read is kept in `read`, as that key.
 */
export class FakeSecretsGit implements SecretsGit {
  index: PatchAdds | undefined = { paths: [], lines: [] };
  readonly known = new Set<string>();
  readonly logs = new Map<string, readonly CommitAdds[]>();
  readonly read: string[] = [];
  logFails = false;
  private readonly top: string;

  constructor(top: string) {
    this.top = top;
  }

  root(): string {
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
}

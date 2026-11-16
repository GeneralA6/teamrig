import type { SecretScanner } from '../core/secrets.ts';
import { GitHubIssueHost } from '../github/host.ts';
import { RepoTokens } from '../github/tokens.ts';
import type { HostKind, IssueHost } from '../issues/host.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * The adapter for a host kind (issues/host.ts), the one place the CLI names a host. A command makes one per run and
 * keeps it, so the run reads each owner's saved key once (github/tokens.ts caches it). `stamp` is the team's
 * github.stamp: whether each text posted ends with the made-with-teamrig footer.
 */
export function hostOf(kind: HostKind, runtime: CliRuntime, scanner: SecretScanner, stamp: boolean): IssueHost {
  switch (kind) {
    case 'github':
      return new GitHubIssueHost(runtime.gh, new RepoTokens(runtime.credentials, runtime.env), scanner, stamp);
  }
}

/** The repositories to read: every one of `github.repos`, or the one `--repo` names, which must be among them. */
export function reposOf(repos: readonly string[], asked: string | undefined): readonly string[] {
  if (asked === undefined) {
    return repos;
  }
  const repo = asked.trim().toLowerCase();
  if (!repos.includes(repo)) {
    throw new RefusedError(`--repo ${asked} is not one of github.repos (${repos.join(', ')})`);
  }
  return [repo];
}

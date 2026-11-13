import type { SecretScanner } from '../core/secrets.ts';
import { GitHubIssueHost } from '../github/host.ts';
import { RepoTokens } from '../github/tokens.ts';
import type { HostKind, IssueHost } from '../issues/host.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The adapter for a host kind (issues/host.ts), the one place the CLI names a host. A command makes one per run and
 * keeps it, so the run reads each owner's saved key once (github/tokens.ts caches it).
 */
export function hostOf(kind: HostKind, runtime: CliRuntime, scanner: SecretScanner): IssueHost {
  switch (kind) {
    case 'github':
      return new GitHubIssueHost(runtime.gh, new RepoTokens(runtime.credentials, runtime.env), scanner);
  }
}

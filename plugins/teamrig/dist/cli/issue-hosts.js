import { GitHubIssueHost } from "../github/host.js";
import { RepoTokens } from "../github/tokens.js";
/**
 * The adapter for a host kind (issues/host.ts), the one place the CLI names a host. A command makes one per run and
 * keeps it, so the run reads each owner's saved key once (github/tokens.ts caches it).
 */
export function hostOf(kind, runtime, scanner) {
    switch (kind) {
        case 'github':
            return new GitHubIssueHost(runtime.gh, new RepoTokens(runtime.credentials, runtime.env), scanner);
    }
}

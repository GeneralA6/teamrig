import { ghOverProgram } from '../../../github/gh-program.ts';
import { GitHubIssueHost } from '../../../github/host.ts';
import { RepoTokens } from '../../../github/tokens.ts';
import { defineConnector } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';

/**
 * The GitHub adapter. GitHub is the tracker and the code host of its repositories, so one host is both ports, and
 * the two share one read of each owner's saved key. The host's code still lives in src/github, beyond what an
 * adapter may import (the boundary check counts these three imports): it moves into this folder next.
 */
export default defineConnector({
  declaration,
  create: (deps) => {
    const host = new GitHubIssueHost(ghOverProgram(deps.run), new RepoTokens(deps.credentials, deps.env), deps.scanner, deps.stamp);
    return { tracker: host, codeHost: host };
  },
});

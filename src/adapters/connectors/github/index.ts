import { ghRunnerOver } from './gh.ts';
import { GitHubIssueHost } from './host.ts';
import { RepoTokens } from './tokens.ts';
import { defineConnector } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';

/**
 * The GitHub adapter. GitHub is the tracker and the code host of its repositories, so one host is both ports, and
 * the two share one read of each owner's saved key. Every run of `gh` goes through one gh runner over the program
 * runner it is handed, which keeps the allow list and the label-file memory (gh.ts). All of the host's code is in
 * this folder and reads teamrig through the plugin API alone.
 */
export default defineConnector({
  declaration,
  create: (deps) => {
    const host = new GitHubIssueHost(ghRunnerOver(deps.run), new RepoTokens(deps.credentials, deps.env), deps.scanner, deps.stamp);
    return { tracker: host, codeHost: host };
  },
});

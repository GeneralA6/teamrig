import { setTimeout as sleep } from 'node:timers/promises';
import { defineConnector } from '../../../plugin-api/index.ts';
import { JiraClient } from './client.ts';
import { parseJiraConfig } from './config.ts';
import { declaration } from './declaration.ts';
import { JiraTracker } from './tracker.ts';

/**
 * The Jira adapter: the tracker of a Jira Cloud project, reached over Jira's REST API with the credential saved for
 * its site. Jira holds no code, so it builds no code host. A rate limit is waited out on a real timer, stretched by
 * chance so sessions limited together do not all return together.
 */
export default defineConnector({
  declaration,
  parseConfig: parseJiraConfig,
  create: (deps, config) => ({ tracker: new JiraTracker(new JiraClient(deps.http, deps.credentials, deps.scanner, sleep, Math.random), deps.stamp, config.issueType) }),
});

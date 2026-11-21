import { setTimeout as sleep } from 'node:timers/promises';
import { defineConnector } from "../../../plugin-api/index.js";
import { JiraClient } from "./client.js";
import { declaration } from "./declaration.js";
import { JiraTracker } from "./tracker.js";
/**
 * The Jira adapter: the tracker of a Jira Cloud project, reached over Jira's REST API with the credential saved for
 * its site. Jira holds no code, so it builds no code host. A rate limit is waited out on a real timer, stretched by
 * chance so sessions limited together do not all return together.
 */
export default defineConnector({
    declaration,
    create: (deps) => ({ tracker: new JiraTracker(new JiraClient(deps.http, deps.credentials, deps.scanner, sleep, Math.random), deps.stamp) }),
});

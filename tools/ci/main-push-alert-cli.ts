import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runMain } from '../lib/run-main.ts';
import { ghCreateIssue, ghMergedPullOf, raiseMainPushAlert, type RunGh } from './main-push-alert.ts';

const run = promisify(execFile);

/** The GitHub CLI, which reads GH_TOKEN and GH_REPO; arguments go by argv, never through a shell. */
const gh: RunGh = async (args) => (await run('gh', [...args], { windowsHide: true })).stdout;

process.exitCode = await runMain(
  'main-push-alert',
  () => raiseMainPushAlert(process.env, (path) => readFile(path, 'utf8'), ghMergedPullOf(gh), ghCreateIssue(gh), (line) => console.log(line)),
  (line) => console.error(line),
);

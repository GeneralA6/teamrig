import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runMain } from '../lib/run-main.ts';
import { raiseMainPushAlert, type CreateIssue } from './main-push-alert.ts';

const run = promisify(execFile);

/** Opens the issue with the GitHub CLI, which reads GH_TOKEN and GH_REPO; the text goes by argv, never through a shell. */
const createIssue: CreateIssue = async ({ title, body }) =>
  (await run('gh', ['issue', 'create', '--title', title, '--body', body], { windowsHide: true })).stdout;

process.exitCode = await runMain(
  'main-push-alert',
  () => raiseMainPushAlert(process.env, (path) => readFile(path, 'utf8'), createIssue, (line) => console.log(line)),
  (line) => console.error(line),
);

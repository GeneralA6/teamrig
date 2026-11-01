import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runMain } from '../lib/run-main.ts';
import { mergedPullEndingOn, raiseMainPushAlert, type CreateIssue, type MergedPullOf } from './main-push-alert.ts';

const run = promisify(execFile);

/** Asks GitHub which merged pull requests brought the commit in; `gh api` fills `{owner}/{repo}` from GH_REPO. */
const mergedPullOf: MergedPullOf = async (sha) =>
  mergedPullEndingOn(JSON.parse((await run('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`], { windowsHide: true })).stdout), sha);

/** Opens the issue with the GitHub CLI, which reads GH_TOKEN and GH_REPO; the text goes by argv, never through a shell. */
const createIssue: CreateIssue = async ({ title, body }) =>
  (await run('gh', ['issue', 'create', '--title', title, '--body', body], { windowsHide: true })).stdout;

process.exitCode = await runMain(
  'main-push-alert',
  () => raiseMainPushAlert(process.env, (path) => readFile(path, 'utf8'), mergedPullOf, createIssue, (line) => console.log(line)),
  (line) => console.error(line),
);

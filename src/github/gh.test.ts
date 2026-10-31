import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhNotReadError, isIssueQuery, nodeGhRunner } from './gh.ts';
import { CLOSED_ISSUES_QUERY, closedPageArgs, OPEN_ISSUES_QUERY, openPageArgs } from './queries.ts';

const DIR = mkdtempSync(join(tmpdir(), 'teamrig-gh-'));
const ENV = { ...process.env };
/** A first page of acme/web's open issues: a command line the runner starts. */
const READ = openPageArgs({ owner: 'acme', name: 'web', after: undefined });

after(() => rmSync(DIR, { recursive: true, force: true }));

/** A Node script in the temp folder that stands in for gh; returns its path. */
function script(name: string, source: string): string {
  const path = join(DIR, name);
  writeFileSync(path, source);
  return path;
}

describe('isIssueQuery', () => {
  const OPEN = ['api', 'graphql', '-f', `query=${OPEN_ISSUES_QUERY}`];

  it('takes a page of the shipped issue queries', () => {
    const page = { owner: 'acme', name: 'web', after: undefined };
    for (const args of [openPageArgs(page), openPageArgs({ ...page, after: 'Y3Vyc29y' }), closedPageArgs(page, '2030-01-01T00:00:00Z')]) {
      assert.equal(isIssueQuery(args), true, args.slice(4).join(' '));
    }
  });

  it('refuses every other gh command, the issue list teamrig once ran among them', () => {
    for (const args of [['issue', 'list', '-R', 'acme/web'], ['issue', 'close', '7'], ['issue', 'edit', '7'], ['issue', 'comment', '7'], ['api', '-X', 'POST', 'repos/acme/web/issues'], ['label', 'create', 'p1'], ['issue'], []]) {
      assert.equal(isIssueQuery(args), false, args.join(' '));
    }
  });

  it('takes each variable a query declares once, as a raw field', () => {
    assert.equal(isIssueQuery([...OPEN, '-f', 'owner=acme', '-f', 'name=web', '-f', 'after=abc']), true);
    assert.equal(isIssueQuery(['api', 'graphql', '-f', `query=${CLOSED_ISSUES_QUERY}`, '-f', 'owner=acme', '-f', 'since=2030-01-01T00:00:00Z']), true);
    assert.equal(isIssueQuery([...OPEN, '-f', 'owner=a=b; $(x)']), true, 'a value is data: only the key is judged');
  });

  it('refuses any other query, even one a character off', () => {
    for (const query of ['mutation { closeIssue(input: {issueId: "1"}) { clientMutationId } }', `${OPEN_ISSUES_QUERY} `, OPEN_ISSUES_QUERY.replace('first: 100', 'first: 1')]) {
      assert.equal(isIssueQuery(['api', 'graphql', '-f', `query=${query}`]), false, query.slice(0, 40));
    }
  });

  it('refuses a variable the query does not declare, or one given twice', () => {
    assert.equal(isIssueQuery([...OPEN, '-f', 'since=2030-01-01T00:00:00Z']), false);
    assert.equal(isIssueQuery([...OPEN, '-f', 'owner=acme', '-f', 'owner=evil']), false);
    assert.equal(isIssueQuery([...OPEN, '-f', `query=${OPEN_ISSUES_QUERY}`]), false);
  });

  it('refuses every flag but -f, and a field with no key', () => {
    for (const extra of [['-F', 'owner=@secrets.txt'], ['--paginate'], ['-X', 'POST'], ['--input', 'body.json'], ['--hostname', 'evil.example'], ['-f'], ['-f', '=acme'], ['-f', 'owner']]) {
      assert.equal(isIssueQuery([...OPEN, ...extra]), false, extra.join(' '));
    }
    assert.equal(isIssueQuery(['api', 'repos/acme/web/issues', '-f', `query=${OPEN_ISSUES_QUERY}`]), false);
    assert.equal(isIssueQuery(['api', 'graphql']), false);
  });
});

describe('nodeGhRunner', () => {
  it('passes each argument as a list item, never through a shell, and tells gh not to prompt', async () => {
    const gh = script('echo-args.mjs', 'process.stdout.write(JSON.stringify([process.argv.slice(2), process.env.GH_PROMPT_DISABLED]));');
    const args = openPageArgs({ owner: 'acme', name: 'a;b $(x) "q" | y', after: undefined });
    const result = await nodeGhRunner(process.execPath, [gh]).run({ args, env: ENV });
    assert.deepEqual(result.end, { kind: 'exited', code: 0 });
    assert.deepEqual(JSON.parse(result.stdout), [args, '1']);
  });

  it('refuses a command line that is not a page of a shipped query, and starts nothing', async () => {
    const marker = join(DIR, 'started');
    const gh = script('mark.cjs', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
    for (const args of [['issue', 'close', '7'], ['issue', 'list', '-R', 'acme/web'], [...READ, '--paginate']]) {
      await assert.rejects(nodeGhRunner(process.execPath, [gh]).run({ args, env: ENV }), GhNotReadError, args.join(' ').slice(0, 40));
    }
    await assert.rejects(
      nodeGhRunner(process.execPath, [gh]).run({ args: ['issue', 'close', '7'], env: ENV }),
      /teamrig only reads GitHub through its shipped issue queries: it refuses gh issue close with these arguments/,
    );
    assert.equal(existsSync(marker), false);
  });

  it('keeps stdout and stderr apart, with the exit code', async () => {
    const gh = script('fail.mjs', "process.stdout.write('out'); console.error('To get started with GitHub CLI, please run:  gh auth login'); process.exit(4);");
    const result = await nodeGhRunner(process.execPath, [gh]).run({ args: READ, env: ENV });
    assert.deepEqual(result, { end: { kind: 'exited', code: 4 }, stdout: 'out', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
  });

  it('rejects with ENOENT when gh is not installed', async () => {
    await assert.rejects(nodeGhRunner(join(DIR, 'no-such-gh')).run({ args: READ, env: ENV }), { code: 'ENOENT' });
  });

  it('stops a run that outlives its time, and says so by the signal', async () => {
    const gh = script('hang.mjs', 'setTimeout(() => {}, 30_000);');
    const result = await nodeGhRunner(process.execPath, [gh], 300).run({ args: READ, env: ENV });
    assert.equal(result.end.kind, 'signal');
  });
});

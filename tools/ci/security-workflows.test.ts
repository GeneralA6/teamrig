import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const workflows: ReadonlyMap<string, string> = new Map(
  readdirSync(new URL('.github/workflows/', root))
    .filter((name) => name.endsWith('.yml'))
    .map((name) => [name, read(`.github/workflows/${name}`)]),
);

describe('every workflow', () => {
  it('is there to read', () => {
    assert.ok(workflows.has('ci.yml') && workflows.has('codeql.yml'), [...workflows.keys()].join(', '));
  });

  it('pins each action to a full commit SHA with its version beside it, so a moved tag cannot change what runs', () => {
    for (const [name, text] of workflows) {
      for (const [line] of text.matchAll(/^.*\buses: .+$/gm)) {
        assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${name}: ${line.trim()}`);
      }
    }
  });

  it('gives the token read-only contents by default, and never runs a fork pull request with secrets', () => {
    for (const [name, text] of workflows) {
      assert.match(text, /^permissions:\n {2}contents: read\n/m, name);
      assert.doesNotMatch(text, /pull_request_target/, name);
    }
  });

  it('never merges a pull request, so no dependency update lands without a person checking it', () => {
    for (const [name, text] of workflows) {
      assert.doesNotMatch(text, /gh pr merge|--auto\b|enablePullRequestAutoMerge|dependabot\/fetch-metadata|pull-requests: write/, name);
    }
  });
});

describe('codeql.yml', () => {
  const codeql = workflows.get('codeql.yml') ?? '';

  it('scans each pull request, each push to main, weekly and by hand', () => {
    assert.match(codeql, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}schedule:\n {4}- cron: '[\d* ]+'\n {2}workflow_dispatch:\n/m);
  });

  it('scans the TypeScript with the security-extended queries and uploads with a job-scoped write token', () => {
    assert.match(codeql, /^ {4}permissions:\n {6}contents: read\n {6}security-events: write\n/m);
    assert.match(codeql, /^ {10}languages: javascript-typescript$/m);
    assert.match(codeql, /^ {10}build-mode: none$/m);
    assert.match(codeql, /^ {10}queries: security-extended$/m);
    assert.match(codeql, /^ {10}category: \/language:javascript-typescript$/m);
    const init = /github\/codeql-action\/init@([0-9a-f]{40})/.exec(codeql)?.[1];
    assert.ok(init !== undefined && codeql.includes(`github/codeql-action/analyze@${init}`), 'init and analyze run the same release');
  });

  it('skips the compiled dist, which would report each finding of the source twice', () => {
    assert.match(codeql, /^ {12}paths-ignore:\n {14}- plugins\/teamrig\/dist$/m);
  });

  it('stops after at most 20 minutes', () => {
    const minutes = /^ {4}timeout-minutes: (\d+)$/m.exec(codeql)?.[1];
    assert.ok(minutes !== undefined && Number(minutes) <= 20, `timeout-minutes: ${minutes}`);
  });
});

describe('dependabot.yml', () => {
  const dependabot = read('.github/dependabot.yml');
  const updates = new Map(
    dependabot
      .split(/^(?= {2}- package-ecosystem: )/m)
      .slice(1)
      .map((block) => [/^ {2}- package-ecosystem: (\S+)$/m.exec(block)?.[1] ?? '', block]),
  );

  it('proposes npm and GitHub Actions updates', () => {
    assert.match(dependabot, /^version: 2$/m);
    assert.deepEqual([...updates.keys()].sort(), ['github-actions', 'npm']);
  });

  it('proposes no release younger than 14 days, weekly, in one grouped pull request per ecosystem', () => {
    for (const [ecosystem, block] of updates) {
      assert.match(block, /^ {4}directory: \/$/m, ecosystem);
      assert.match(block, /^ {6}interval: weekly$/m, ecosystem);
      const days = /^ {4}cooldown:\n {6}default-days: (\d+)$/m.exec(block)?.[1];
      assert.ok(days !== undefined && Number(days) >= 14, `${ecosystem} cooldown: ${days}`);
      assert.match(block, /^ {4}groups:\n {6}[\w-]+:\n {8}patterns: \['\*'\]$/m, ecosystem);
    }
  });
});

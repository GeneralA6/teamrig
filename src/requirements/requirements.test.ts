import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Env } from '../core/home.ts';
import type { PathProbe } from '../core/path-probe.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import {
  claudeCodeVersion,
  describeRequirement,
  isOlder,
  MIN_CLAUDE_CODE,
  MIN_NODE,
  parseVersion,
  requirementsCheck,
  versionText,
  type RequirementDeps,
  type RequirementProblem,
} from './requirements.ts';

const GIT = '/usr/bin/git';
const PATH = '/usr/local/bin:/usr/bin';
const CURRENT: Env = { PATH, AI_AGENT: 'claude-code_2-1-300_harness' };

function deps(overrides: Partial<RequirementDeps> = {}): RequirementDeps {
  return { env: CURRENT, platform: 'linux', probe: new FakePathProbe({ files: [GIT] }), nodeVersion: '22.19.0', ...overrides };
}

function problems(overrides: Partial<RequirementDeps> = {}): Promise<readonly RequirementProblem[]> {
  return requirementsCheck(deps(overrides)).problems();
}

describe('versions', () => {
  it('reads x.y, x.y.z and a leading v', () => {
    assert.deepEqual(parseVersion('22.18'), { major: 22, minor: 18, patch: 0 });
    assert.deepEqual(parseVersion(' v22.19.1 '), { major: 22, minor: 19, patch: 1 });
    assert.equal(parseVersion('latest'), undefined);
  });

  it("reads the running Claude Code from $AI_AGENT, a hook's or the Bash tool's", () => {
    assert.deepEqual(claudeCodeVersion({ AI_AGENT: 'claude-code_2-1-300_harness' }), { major: 2, minor: 1, patch: 300 });
    assert.deepEqual(claudeCodeVersion({ AI_AGENT: 'claude-code_2-1-139_agent' }), { major: 2, minor: 1, patch: 139 });
    assert.deepEqual(claudeCodeVersion({ AI_AGENT: 'claude-code_3-0-0' }), { major: 3, minor: 0, patch: 0 });
  });

  it('knows no version without $AI_AGENT or from another agent', () => {
    assert.equal(claudeCodeVersion({}), undefined);
    assert.equal(claudeCodeVersion({ AI_AGENT: 'cursor_1-2-3' }), undefined);
    assert.equal(claudeCodeVersion({ AI_AGENT: 'claude-code_2-1-300x' }), undefined);
  });

  it('orders by major, then minor, then patch', () => {
    assert.equal(isOlder({ major: 2, minor: 1, patch: 138 }, MIN_CLAUDE_CODE), true);
    assert.equal(isOlder({ major: 2, minor: 1, patch: 139 }, MIN_CLAUDE_CODE), false);
    assert.equal(isOlder({ major: 2, minor: 2, patch: 0 }, MIN_CLAUDE_CODE), false);
    assert.equal(isOlder({ major: 1, minor: 9, patch: 999 }, MIN_CLAUDE_CODE), true);
    assert.equal(isOlder({ major: 24, minor: 0, patch: 0 }, MIN_NODE), false);
  });

  it("keeps the Node.js minimum at package.json's engines.node", () => {
    const engines = /"node":\s*">=([\d.]+)"/.exec(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))?.[1];
    assert.ok(engines !== undefined, 'package.json gives engines.node as >=x.y');
    assert.deepEqual(parseVersion(engines), MIN_NODE);
  });
});

describe('requirementsCheck', () => {
  it('finds nothing when git is on PATH and Claude Code and Node.js are new enough', async () => {
    assert.deepEqual(await problems(), []);
  });

  it('finds git missing from PATH', async () => {
    assert.deepEqual(await problems({ probe: new FakePathProbe() }), [{ kind: 'git-missing' }]);
  });

  it('finds git.exe on Windows', async () => {
    const probe = new FakePathProbe({ files: ['C:\\Program Files\\Git\\cmd\\git.exe'] });
    assert.deepEqual(await problems({ platform: 'win32', env: { Path: 'C:\\Program Files\\Git\\cmd', AI_AGENT: 'claude-code_2-1-300_agent' }, probe }), []);
  });

  it('finds a Claude Code older than the hooks need', async () => {
    assert.deepEqual(await problems({ env: { ...CURRENT, AI_AGENT: 'claude-code_2-1-138_agent' } }), [{ kind: 'claude-code-old', running: '2.1.138' }]);
  });

  it('finds a Node.js older than package.json supports', async () => {
    assert.deepEqual(await problems({ nodeVersion: '20.11.1' }), [{ kind: 'node-old', running: '20.11.1' }]);
  });

  it('says nothing of a version it cannot read', async () => {
    assert.deepEqual(await problems({ env: { PATH }, nodeVersion: 'unknown' }), []);
  });

  it('reports every problem at once', async () => {
    const found = await problems({ env: { AI_AGENT: 'claude-code_2-1-120_agent' }, nodeVersion: '18.20.0' });
    assert.deepEqual(found, [{ kind: 'git-missing' }, { kind: 'claude-code-old', running: '2.1.120' }, { kind: 'node-old', running: '18.20.0' }]);
  });

  it('turns a check that throws into a check-failed problem and still runs the others', async () => {
    const failing: PathProbe = {
      kind: async () => {
        throw new Error('EACCES: permission denied');
      },
    };
    const found = await problems({ probe: failing, nodeVersion: '20.0.0' });
    assert.deepEqual(found, [
      { kind: 'check-failed', requirement: 'git', reason: 'EACCES: permission denied' },
      { kind: 'node-old', running: '20.0.0' },
    ]);
  });
});

describe('describeRequirement', () => {
  it('says what is wrong, then the fix, in plain words', () => {
    assert.equal(describeRequirement({ kind: 'git-missing' }, 'teamrig'), 'git is not installed or not on PATH, and teamrig needs it: install it from git-scm.com, then restart Claude Code.');
    assert.equal(
      describeRequirement({ kind: 'claude-code-old', running: '2.1.130' }, 'teamrig'),
      `Claude Code 2.1.130 is older than teamrig needs (${versionText(MIN_CLAUDE_CODE)} or later): run claude update, then restart Claude Code.`,
    );
    assert.equal(
      describeRequirement({ kind: 'node-old', running: '20.11.1' }, 'teamrig'),
      'Node.js 20.11.1 is older than teamrig supports (22.18.0 or later): install the current LTS from nodejs.org, then restart Claude Code.',
    );
    assert.equal(describeRequirement({ kind: 'check-failed', requirement: 'git', reason: 'EACCES' }, 'teamrig'), 'The teamrig check for git failed (EACCES).');
  });
});

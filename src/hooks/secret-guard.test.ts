import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { secretRulesOf } from '../secret-guard/rules.ts';
import { testConfig } from '../testing/config.ts';
import { secretFindingsOf, secretGuardOf, secretGuardOutput, secretReason, type SecretGuardEnv } from './secret-guard.ts';

const RULES = secretRulesOf(DEFAULT_SECRET_GUARD, 'C:/u', 'win32');

function env(overrides: Partial<SecretGuardEnv> = {}): SecretGuardEnv {
  return { cwd: 'C:/w', rules: RULES, secretReads: 'deny', ...overrides };
}

function call(tool_name: string, tool_input: JsonRecord, extra: JsonRecord = {}): JsonRecord {
  return { tool_name, tool_input, ...extra };
}

function findings(payload: JsonRecord): string[] {
  return secretFindingsOf(payload, 'C:/w', RULES).map((finding) => (finding.kind === 'file' ? finding.path : finding.kind));
}

/** The decision and reason the output carries, or undefined for no output. */
function verdictOf(output: string): { readonly decision: string | undefined; readonly reason: string | undefined } | undefined {
  if (output === '') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(output);
  const hook = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
  assert.ok(isRecord(hook));
  assert.equal(stringField(hook, 'hookEventName'), 'PreToolUse');
  return { decision: stringField(hook, 'permissionDecision'), reason: stringField(hook, 'permissionDecisionReason') };
}

describe('secretFindingsOf', () => {
  it('reads a Bash or a PowerShell line in its own dialect, from the folder the payload names', () => {
    assert.deepEqual(findings(call('Bash', { command: 'cat .env; cat app.json' })), ['.env']);
    assert.deepEqual(findings(call('PowerShell', { command: 'Get-Content ~/.npmrc; $env:NPM_TOKEN' })), ['~/.npmrc', 'variable']);
    assert.deepEqual(findings(call('Bash', { command: 'cat ../u/.npmrc' }, { cwd: 'C:/w' })), ['../u/.npmrc']);
    assert.deepEqual(findings(call('Bash', { command: 'cat ../u/.npmrc' }, { cwd: 'C:/x/y' })), []);
    assert.deepEqual(findings(call('Bash', { command: 7 })), []);
  });

  it('reads the file a Read opens, a relative one from the call folder', () => {
    assert.deepEqual(findings(call('Read', { file_path: 'C:/u/.npmrc' })), ['C:/u/.npmrc']);
    assert.deepEqual(findings(call('Read', { file_path: 'C:\\w\\.env.local' })), ['C:\\w\\.env.local']);
    assert.deepEqual(findings(call('Read', { file_path: '.env' }, { cwd: 'C:/w/app' })), ['.env']);
    assert.deepEqual(findings(call('Read', { file_path: 'C:/w/.env.example' })), []);
    assert.deepEqual(findings(call('Read', { file_path: 'C:/w/src/app.ts' })), []);
  });

  it('reads a Grep that shows the lines of a secret file, by path or glob, and lets one that lists names or counts pass', () => {
    assert.deepEqual(findings(call('Grep', { pattern: 'x', path: '.env', output_mode: 'content' })), ['.env']);
    assert.deepEqual(findings(call('Grep', { pattern: 'x', glob: '.env*', output_mode: 'content' })), ['.env*']);
    assert.deepEqual(findings(call('Grep', { pattern: 'x', path: 'C:/u/.ssh', output_mode: 'content' })), ['C:/u/.ssh']);
    assert.deepEqual(findings(call('Grep', { pattern: 'x', path: 'C:/u', glob: '.npmrc', output_mode: 'content' })), ['.npmrc']);
    assert.deepEqual(findings(call('Grep', { pattern: 'x', path: '.env' })), []);
    assert.deepEqual(findings(call('Grep', { pattern: 'x', path: '.env', output_mode: 'count' })), []);
    assert.deepEqual(findings(call('Grep', { pattern: 'x', path: 'src', glob: '*.ts', output_mode: 'content' })), []);
  });

  it('reads no other tool', () => {
    assert.deepEqual(findings(call('Glob', { pattern: '**/.env' })), []);
    assert.deepEqual(findings(call('Write', { file_path: '.env', content: 'A=1' })), []);
  });
});

describe('secretGuardOutput', () => {
  it('refuses a call that prints a secret, naming each one and the ways to use a secret unprinted', () => {
    const verdict = verdictOf(secretGuardOutput(call('Bash', { command: 'cat .env; printenv NPM_TOKEN' }), env()));
    assert.equal(verdict?.decision, 'deny');
    assert.equal(
      verdict?.reason,
      secretReason([
        { kind: 'file', path: '.env' },
        { kind: 'variable', name: 'NPM_TOKEN' },
      ]),
    );
    assert.match(verdict?.reason ?? '', /would print the content of \.env and the value of \$NPM_TOKEN into the conversation\. .*grep -q/);
  });

  it('asks instead when the team set ask, and prints nothing when it set allow', () => {
    const read = call('Read', { file_path: 'C:/w/.env' });
    assert.equal(verdictOf(secretGuardOutput(read, env({ secretReads: 'ask' })))?.decision, 'ask');
    assert.equal(secretGuardOutput(read, env({ secretReads: 'allow' })), '');
  });

  it('prints nothing for a call that prints no secret, or input that is not a payload', () => {
    assert.equal(secretGuardOutput(call('Bash', { command: 'cat .env | wc -c' }), env()), '');
    assert.equal(secretGuardOutput('cat .env', env()), '');
  });
});

describe('secretReason', () => {
  it('names one secret alone, and joins several', () => {
    assert.match(secretReason([{ kind: 'environment' }]), /would print the whole environment into/);
    assert.match(secretReason([{ kind: 'environment' }, { kind: 'kube-secret' }, { kind: 'file', path: 'a.pem' }]), /environment, a Kubernetes secret's data and the content of a\.pem into/);
  });
});

describe('secretGuardOf', () => {
  it("reads the team's config, and keeps the default when it is missing or unreadable", () => {
    const config = testConfig({ secretGuard: { secretReads: 'ask', paths: ['secrets/**'], envNames: [] } });
    assert.equal(secretGuardOf({ status: 'loaded', path: 'c.json', config, issues: [] }).secretReads, 'ask');
    for (const load of [undefined, { status: 'missing', path: 'c.json' } as const, { status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } } as const]) {
      assert.deepEqual(secretGuardOf(load), DEFAULT_SECRET_GUARD);
    }
  });
});

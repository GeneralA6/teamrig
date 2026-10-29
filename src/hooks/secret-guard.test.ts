import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { secretRulesOf } from '../secret-guard/rules.ts';
import { testConfig } from '../testing/config.ts';
import { secretFindingsOf, secretGuardOf, secretGuardOutput, secretPatternsOf, secretReason, type SecretGuardEnv } from './secret-guard.ts';

const RULES = secretRulesOf(DEFAULT_SECRET_GUARD, 'C:/u', 'win32');
const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));
const PASSWORD = join('s3', 'cret', 'Value9');

function env(overrides: Partial<SecretGuardEnv> = {}): SecretGuardEnv {
  return { cwd: 'C:/w', rules: RULES, secretReads: 'deny', hookAsks: 'ask', ...overrides };
}

function call(tool_name: string, tool_input: JsonRecord, extra: JsonRecord = {}): JsonRecord {
  return { tool_name, tool_input, ...extra };
}

function findings(payload: JsonRecord, rules = RULES): string[] {
  return secretFindingsOf(payload, 'C:/w', rules).map((finding) => {
    switch (finding.kind) {
      case 'file':
        return finding.path;
      case 'literal':
        return finding.id;
      default:
        return finding.kind;
    }
  });
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

  it('finds a secret a Bash or PowerShell line holds as text, a quiet run too, before what the line prints', () => {
    assert.deepEqual(findings(call('Bash', { command: join('curl -s https://app:', PASSWORD, '@queue.local/q > /dev/null') })), ['url-credentials']);
    assert.deepEqual(findings(call('PowerShell', { command: join('Get-Content .env; gh auth status --token ', TOKEN) })), ['github-token', '.env']);
    assert.deepEqual(findings(call('Bash', { command: 'curl -H "Authorization: Bearer $GH_TOKEN" https://api.local' })), []);
  });

  it("finds a line's text by the team's own secret patterns", () => {
    const rules = secretRulesOf(DEFAULT_SECRET_GUARD, 'C:/u', 'win32', ['tok_[a-z0-9]{8}']);
    assert.deepEqual(findings(call('Bash', { command: join('deploy --key tok_', 'q8r7s6t5') }), rules), ['config-1']);
    assert.deepEqual(findings(call('Bash', { command: join('deploy --key tok_', 'q8r7s6t5') })), []);
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

  it("reads a Grep's glob input as ripgrep gets it: each glob apart, a !glob skipping files and naming none", () => {
    const grep = (glob: string): string[] => findings(call('Grep', { pattern: 'pushToProtected', path: 'C:/w/t', glob, output_mode: 'content' }));
    assert.deepEqual(grep('!{dist,node_modules}/**'), []);
    assert.deepEqual(grep('*.ts !.env'), []);
    assert.deepEqual(grep('!.env,*.md'), []);
    assert.deepEqual(grep('!dist/**  .env*'), ['.env*']);
    assert.deepEqual(grep('*.ts,*.pem,'), ['*.pem']);
    assert.deepEqual(grep('*.{ts,md} .env'), ['.env']);
    assert.deepEqual(grep('.env,{a}'), []);
    assert.deepEqual(grep(' '), []);
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

  it('refuses a line that holds a secret as text, naming its shape and the ways to pass it by reference, never its value', () => {
    const verdict = verdictOf(secretGuardOutput(call('Bash', { command: join('curl -s https://app:', PASSWORD, '@queue.local/q > /dev/null') }), env()));
    assert.equal(verdict?.decision, 'deny');
    assert.equal(
      verdict?.reason,
      "teamrig secret guard: this call's command line holds a secret as text (credentials in a URL). Pass it by reference " +
        '(its env var name, a file path, stdin, `teamrig exec request`), never as text. [secretGuard.secretReads]',
    );
  });

  it('asks instead when the team set ask, and prints nothing when it set allow', () => {
    const read = call('Read', { file_path: 'C:/w/.env' });
    assert.equal(verdictOf(secretGuardOutput(read, env({ secretReads: 'ask' })))?.decision, 'ask');
    assert.equal(secretGuardOutput(read, env({ secretReads: 'allow' })), '');
  });

  it('refuses with the note on what to do instead of asking when asks are off, and keeps a refusal as it was', () => {
    const read = call('Read', { file_path: 'C:/w/.env' });
    const refused = verdictOf(secretGuardOutput(read, env({ secretReads: 'ask', hookAsks: 'refuse' })));
    assert.equal(refused?.decision, 'deny');
    assert.match(refused?.reason ?? '', /would print the content of C:\/w\/\.env .*Asks are off \[prompts\.hookAsks\]/);
    const denied = verdictOf(secretGuardOutput(read, env({ hookAsks: 'refuse' })));
    assert.equal(denied?.decision, 'deny');
    assert.doesNotMatch(denied?.reason ?? '', /Asks are off/);
  });

  it('prints nothing for a call that prints no secret, or input that is not a payload', () => {
    assert.equal(secretGuardOutput(call('Bash', { command: 'cat .env | wc -c' }), env()), '');
    assert.equal(secretGuardOutput('cat .env', env()), '');
  });
});

describe('secretGuardOutput on what a command line holds (T1369 acceptance)', () => {
  const decisionOf = (tool: string, command: string): string | undefined => verdictOf(secretGuardOutput(call(tool, { command }), env()))?.decision;
  const BEARER = join('k9Qz', '7Lm4xR2tVb8nW3');
  const API_KEY = join('a7f3', 'c9e1b5d2');

  it('refuses a secret written into the line, a command that dumps credentials and a secret file git would show', () => {
    for (const [tool, command] of [
      ['Bash', join('psql postgres://app:', PASSWORD, '@db.local/app -c "select 1"')],
      ['Bash', join('curl -H "Authorization: Bearer ', BEARER, '" https://api.local/v1')],
      ['PowerShell', join('Invoke-RestMethod https://api.local/v1 -Headers @{ Authorization = "Bearer ', BEARER, '" }')],
      ['Bash', join('curl -H "x-api-key: ', API_KEY, '" https://api.local/v1')],
      ['Bash', 'kubectl config view --raw'],
      ['Bash', 'kubectl --raw config view'],
      ['PowerShell', 'kubectl --context prod config view --minify --raw=true'],
      ['Bash', 'git show HEAD~1:.env'],
      ['Bash', 'git diff -- .env'],
    ] as const) {
      assert.equal(decisionOf(tool, command), 'deny', command);
    }
  });

  it('lets a placeholder, a reference, a search for a shape, a plain view and a quiet dump pass', () => {
    for (const [tool, command] of [
      ['Bash', 'psql postgres://user:password@localhost/app'],
      ['Bash', 'psql "${DB_URI}"'],
      ['PowerShell', 'psql $env:DB_URI'],
      ['Bash', 'psql postgres://app:<db_password>@localhost/app'],
      ['Bash', "grep -rE 'postgres://[^:]+:[^@]+@' src"],
      ['Bash', 'git log -p -- src/'],
      ['Bash', 'kubectl config view'],
      ['Bash', 'kubectl config view --raw > kubeconfig.yaml'],
    ] as const) {
      assert.equal(decisionOf(tool, command), undefined, command);
    }
  });
});

describe('secretReason', () => {
  it('names one secret alone, and joins several', () => {
    assert.match(secretReason([{ kind: 'environment' }]), /would print the whole environment into/);
    assert.match(secretReason([{ kind: 'environment' }, { kind: 'kube-secret' }, { kind: 'file', path: 'a.pem' }]), /environment, a Kubernetes secret's data and the content of a\.pem into/);
  });

  it('says what the call prints, then the secrets its line holds as text', () => {
    const reason = secretReason([
      { kind: 'literal', id: 'github-token', description: 'GitHub token' },
      { kind: 'file', path: '.env' },
      { kind: 'literal', id: 'jwt', description: 'JSON web token' },
    ]);
    assert.match(
      reason,
      /^teamrig secret guard: this call would print the content of \.env into the conversation\. .*secretGuard\.envNames or secretGuard\.commands\. Its command line holds a secret as text \(GitHub token, JSON web token\)\. Pass it by reference .*never as text\. \[secretGuard\.secretReads\]$/,
    );
  });
});

describe('secretPatternsOf', () => {
  it("reads the team's own secret patterns, and none when the config is missing or unreadable", () => {
    const config = testConfig({ register: { secretPatterns: ['tok_[a-z0-9]{8}'] } });
    assert.deepEqual(secretPatternsOf({ status: 'loaded', path: 'c.json', config, issues: [] }), ['tok_[a-z0-9]{8}']);
    for (const load of [undefined, { status: 'missing', path: 'c.json' } as const]) {
      assert.deepEqual(secretPatternsOf(load), []);
    }
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

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
  return { cwd: 'C:/w', rules: RULES, secretReads: 'deny', writes: 'deny', hookAsks: 'ask', platform: 'linux', ...overrides };
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
      case 'written':
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

  const grep = (glob: string): string[] => findings(call('Grep', { pattern: 'x', path: 'C:/w/t', glob, output_mode: 'content' }));

  it('reads a backslash and a } no { opened out of a Grep glob, as ripgrep does', () => {
    assert.deepEqual(grep('*.\\pem'), ['*.\\pem']);
    assert.deepEqual(grep('.en\\v*'), ['.en\\v*']);
    assert.deepEqual(grep('*.pem}'), ['*.pem}']);
    assert.deepEqual(grep('a.ts,*.pem}'), ['*.pem}']);
    assert.deepEqual(grep('{x\\},.env*}'), ['{x\\},.env*}']);
    assert.deepEqual(grep('src\\.env'), []);
  });

  it("reads each {a,b} alternative of a Grep glob, and counts one with too many as naming a secret", () => {
    assert.deepEqual(grep('*.{ts,pem}'), ['*.{ts,pem}']);
    assert.deepEqual(grep('*.{ts,{md,key}}'), ['*.{ts,{md,key}}']);
    assert.deepEqual(grep('{src,.env*}'), ['{src,.env*}']);
    assert.deepEqual(grep('*.{ts,md,json}'), []);
    assert.deepEqual(grep('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}'), ['{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}']);
    const alternatives = (count: number): string => `{${Array.from({ length: count }, (_, index) => `f${index}`).join(',')}}`;
    assert.deepEqual(grep(alternatives(64)), []);
    assert.deepEqual(grep(alternatives(65)), [alternatives(65)]);
  });

  it('reads a [...] set in a Grep glob group as ripgrep does, a / and a { in it too', () => {
    for (const glob of ['{[{/],*.pem}', '{[{/],.env*}', '*.{[{/],pem}', '{[{/]x,*.key}', '{[!/{],*.pem}', '{[^]{],*.pem}']) {
      assert.deepEqual(grep(glob), [glob]);
    }
    assert.deepEqual(grep('{[{/],*.ts}'), []);
  });

  it('counts a Grep glob too long to read in time as naming a secret, one at the bound still read', () => {
    const padded = (length: number): string => `*.ts${'x'.repeat(length - 4)}`;
    assert.deepEqual(grep(padded(1024)), []);
    assert.deepEqual(grep(padded(1025)), [padded(1025)]);
  });

  it('reads no other tool', () => {
    assert.deepEqual(findings(call('Glob', { pattern: '**/.env' })), []);
  });
});

describe('secretFindingsOf on the text a file-writing call writes (T1369 R3)', () => {
  it('finds a secret a Write, Edit, MultiEdit or NotebookEdit writes, in a test file or a committed example too', () => {
    assert.deepEqual(findings(call('Write', { file_path: 'C:/w/src/a.ts', content: join('send("', TOKEN, '");') })), ['github-token']);
    assert.deepEqual(findings(call('Write', { file_path: 'C:/w/src/a.test.ts', content: TOKEN })), ['github-token']);
    assert.deepEqual(findings(call('Write', { file_path: 'C:/w/.env.example', content: join('GH=', TOKEN) })), ['github-token']);
    assert.deepEqual(findings(call('Write', { content: TOKEN })), ['github-token']);
    assert.deepEqual(findings(call('Edit', { file_path: 'C:/w/src/a.ts', old_string: 'x', new_string: TOKEN })), ['github-token']);
    assert.deepEqual(
      findings(call('MultiEdit', { file_path: 'C:/w/q.yaml', edits: [{ old_string: 'a', new_string: 'b' }, 'not an edit', { old_string: 'c', new_string: join('url: https://app:', PASSWORD, '@queue.local/q') }] })),
      ['url-credentials'],
    );
    assert.deepEqual(findings(call('NotebookEdit', { notebook_path: 'C:/w/nb.ipynb', new_source: join('key = "', TOKEN, '"') })), ['github-token']);
  });

  it("finds a written text by the team's own secret patterns", () => {
    const rules = secretRulesOf(DEFAULT_SECRET_GUARD, 'C:/u', 'win32', ['tok_[a-z0-9]{8}']);
    assert.deepEqual(findings(call('Write', { file_path: 'C:/w/deploy.sh', content: join('deploy --key tok_', 'q8r7s6t5') }), rules), ['config-1']);
  });

  it('lets a write to a secret file, text it replaces, a placeholder, a reference and a fixture built from parts pass', () => {
    assert.deepEqual(findings(call('Write', { file_path: 'C:/w/.env', content: join('GH=', TOKEN) })), []);
    assert.deepEqual(findings(call('Write', { file_path: '.env', content: join('GH=', TOKEN) }, { cwd: 'C:/w/app' })), []);
    assert.deepEqual(findings(call('Edit', { file_path: 'C:/u/.npmrc', old_string: 'x', new_string: TOKEN })), []);
    assert.deepEqual(findings(call('Edit', { file_path: 'C:/w/src/a.ts', old_string: TOKEN, new_string: 'process.env.GH_TOKEN' })), []);
    for (const content of [
      'url: postgres://user:password@localhost/app',
      'curl -H "Authorization: Bearer $GH_TOKEN" https://api.local',
      "const token = join('gh', 'p_', 'a1'.repeat(18));",
    ]) {
      assert.deepEqual(findings(call('Write', { file_path: 'C:/w/src/a.ts', content })), [], content);
    }
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
        '(its env var name, a file path, stdin, `teamrig exec request`), never as text. [secretGuard.writes]',
    );
  });

  it('refuses a write whose text holds a secret, naming its shape, where a real one belongs and how a test builds one', () => {
    const verdict = verdictOf(secretGuardOutput(call('Edit', { file_path: 'C:/w/src/a.ts', old_string: 'x', new_string: TOKEN }), env()));
    assert.equal(verdict?.decision, 'deny');
    assert.equal(
      verdict?.reason,
      'teamrig secret guard: the text this call writes holds a secret (GitHub token). Keep a real one in a secret file ' +
        '(secretGuard.paths, such as .env) and name it by its env var or path; a test builds a secret-shaped value at run ' +
        "time from parts (join('gh', 'p_', ...)), so no file holds it whole. [secretGuard.writes]",
    );
    assert.doesNotMatch(verdict?.reason ?? '', new RegExp(TOKEN));
  });

  it('asks instead when the team set ask, and prints nothing when it set allow', () => {
    const read = call('Read', { file_path: 'C:/w/.env' });
    assert.equal(verdictOf(secretGuardOutput(read, env({ secretReads: 'ask' })))?.decision, 'ask');
    assert.equal(secretGuardOutput(read, env({ secretReads: 'allow' })), '');
    const write = call('Write', { file_path: 'C:/w/src/a.ts', content: TOKEN });
    assert.equal(verdictOf(secretGuardOutput(write, env({ writes: 'ask' })))?.decision, 'ask');
    assert.equal(secretGuardOutput(write, env({ writes: 'allow' })), '');
  });

  it('settles a printed secret by secretReads and one held as text by writes, naming only what a key does not allow', () => {
    const write = call('Write', { file_path: 'C:/w/src/a.ts', content: TOKEN });
    assert.equal(verdictOf(secretGuardOutput(write, env({ secretReads: 'allow' })))?.decision, 'deny');
    assert.equal(verdictOf(secretGuardOutput(call('Read', { file_path: 'C:/w/.env' }), env({ writes: 'allow' })))?.decision, 'deny');
    const both = call('Bash', { command: join('cat .env; gh auth status --token ', TOKEN) });
    const denied = verdictOf(secretGuardOutput(both, env({ secretReads: 'ask' })));
    assert.equal(denied?.decision, 'deny');
    assert.match(denied?.reason ?? '', /would print the content of \.env .*command line holds a secret as text \(GitHub token\).*\[secretGuard\.secretReads, secretGuard\.writes\]$/);
    const asked = verdictOf(secretGuardOutput(both, env({ secretReads: 'ask', writes: 'allow' })));
    assert.equal(asked?.decision, 'ask');
    assert.match(asked?.reason ?? '', /would print the content of \.env .*\[secretGuard\.secretReads\]$/);
    assert.doesNotMatch(asked?.reason ?? '', /holds a secret as text/);
    assert.equal(secretGuardOutput(both, env({ secretReads: 'allow', writes: 'allow' })), '');
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

  it('lets a call pass whose code holds a reversed range, and refuses one that reaches a secret behind it (T1960)', () => {
    assert.equal(decisionOf('Bash', "node -e 'console.log(`last ${near[near.length-1]}`)'"), undefined);
    assert.equal(decisionOf('Bash', 'cat near[near.length-1]'), undefined);
    assert.equal(decisionOf('Bash', 'cat .en[z-av]'), 'deny');
  });
});

describe('secretGuardOutput on a read of a saved credential (T2654)', () => {
  const outputOf = (tool: string, command: string, overrides: Partial<SecretGuardEnv> = {}): string => secretGuardOutput(call(tool, { command }), env(overrides));

  it("refuses a session's read of the host's credential store, a quiet one too, naming how it reads", () => {
    for (const [tool, command] of [
      ['Bash', "printf 'host=github.com\\n' | git credential fill > /dev/null"],
      ['Bash', 'GH_TOKEN=$(gh auth token) gh api user'],
      ['PowerShell', '$t = gh auth token'],
      ['PowerShell', 'cmdkey /list'],
      ['PowerShell', 'node read-key.mjs teamrig-ship-gh'],
    ] as const) {
      assert.equal(verdictOf(outputOf(tool, command))?.decision, 'deny', command);
    }
    assert.deepEqual(verdictOf(outputOf('Bash', 'gh auth token > t.txt')), {
      decision: 'deny',
      reason: secretReason([{ kind: 'credential', via: 'gh auth token' }]),
    });
  });

  it('says the store is never read and names the key that sets it, before what else the line prints', () => {
    assert.equal(
      secretReason([{ kind: 'credential', via: 'gh auth token' }]),
      "teamrig secret guard: this call reads a saved credential out of the host's credential store (gh auth token), printed " +
        "or not. A session never reads the store: each tool's key stays with the tool that reads it (teamrig's own commands " +
        'read theirs themselves). To check a saved key, ask the owner to look in their own terminal. [secretGuard.secretReads]',
    );
    const reason = secretReason([{ kind: 'credential', via: 'cmdkey /list' }, { kind: 'file', path: '.env' }, { kind: 'literal', id: 'github-token', description: 'GitHub token' }]);
    assert.match(reason, /^teamrig secret guard: this call reads a saved credential .* It would also print the content of \.env into .* Its command line holds a secret as text \(GitHub token\)/);
    assert.match(reason, /\[secretGuard\.secretReads, secretGuard\.writes\]$/);
  });

  it('asks or lets it run as secretGuard.secretReads says, whatever secretGuard.writes says', () => {
    assert.equal(verdictOf(outputOf('Bash', 'gh auth token', { secretReads: 'ask' }))?.decision, 'ask');
    assert.equal(outputOf('Bash', 'gh auth token', { secretReads: 'allow' }), '');
    assert.equal(verdictOf(outputOf('Bash', 'gh auth token', { writes: 'allow' }))?.decision, 'deny');
  });

  it('lets the gh and git lines that read no key pass', () => {
    for (const command of ['gh auth status', 'gh issue list', 'git credential approve < c.txt', 'teamrig gh sync']) {
      assert.equal(outputOf('Bash', command), '', command);
    }
  });
});

describe('secretGuardOutput: a Bash line on Windows (T2319)', () => {
  /** A run of n backslashes; on Windows bash receives each run not before a double quote halved, rounded up. */
  const bs = (n: number): string => '\\'.repeat(n);
  const windows = (overrides: Partial<SecretGuardEnv> = {}): SecretGuardEnv => env({ platform: 'win32', ...overrides });
  const hiddenSeparator = (command: string): string => `echo a${bs(3)}; ${command}`;
  const hiddenBacktick = (command: string): string => `echo "p${bs(3)}\`${command}; echo ${bs(3)}\`q"`;

  it('refuses a secret file read that bash runs behind what the line as written escapes', () => {
    for (const line of [hiddenSeparator('cat .env'), hiddenBacktick('cat .env')]) {
      assert.deepEqual(verdictOf(secretGuardOutput(call('Bash', { command: line }), windows())), { decision: 'deny', reason: secretReason([{ kind: 'file', path: '.env' }]) }, line);
      assert.equal(secretGuardOutput(call('Bash', { command: line }), env()), '', `off Windows bash runs the line as written: ${line}`);
    }
  });

  it('names a secret both readings print once, and leaves a line whose readings print none and a call with no command line as it was', () => {
    const verdict = verdictOf(secretGuardOutput(call('Bash', { command: `cat .env; ${hiddenSeparator('printenv NPM_TOKEN')}` }), windows()));
    assert.deepEqual(verdict, {
      decision: 'deny',
      reason: secretReason([
        { kind: 'file', path: '.env' },
        { kind: 'variable', name: 'NPM_TOKEN' },
      ]),
    });
    for (const benign of [`grep 'a${bs(4)}b' f`, hiddenSeparator('cat .env | wc -c')]) {
      assert.equal(secretGuardOutput(call('Bash', { command: benign }), windows()), '', benign);
    }
    assert.equal(verdictOf(secretGuardOutput(call('Read', { file_path: 'C:/w/.env' }), windows()))?.decision, 'deny');
  });
});

describe("secretGuardOutput on Claude Code's stores and the shells' histories (T1369 acceptance)", () => {
  const decisionOf = (payload: JsonRecord): string | undefined => verdictOf(secretGuardOutput(payload, env()))?.decision;
  const PSREADLINE = 'C:/u/AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt';

  it('refuses a call that shows their lines, and a Grep with content inside a secret file', () => {
    for (const payload of [
      call('Read', { file_path: 'C:/u/.claude/.credentials.json' }),
      call('Read', { file_path: 'C:/w/app/.claude/settings.local.json' }),
      call('Bash', { command: 'tail -n 20 ~/.claude/history.jsonl' }),
      call('Bash', { command: 'grep -i token ~/.bash_history ~/.zsh_history' }),
      call('PowerShell', { command: `Get-Content ${PSREADLINE} -Tail 50` }),
      call('Grep', { pattern: 'token', path: 'C:/u/.kube/config', output_mode: 'content' }),
      call('Grep', { pattern: 'allow', path: 'C:/w/app', glob: '.claude/settings.local.json', output_mode: 'content' }),
    ]) {
      assert.equal(decisionOf(payload), 'deny', JSON.stringify(payload));
    }
  });

  it('lets counts, the shared settings and the project transcripts pass', () => {
    for (const payload of [
      call('Bash', { command: "grep -cE 'tok_[a-z0-9]{8}' ~/.claude/history.jsonl" }),
      call('Bash', { command: 'wc -l ~/.claude/history.jsonl' }),
      call('Grep', { pattern: 'token', path: 'C:/u/.claude/history.jsonl', output_mode: 'count' }),
      call('Read', { file_path: 'C:/w/app/.claude/settings.json' }),
      call('Read', { file_path: 'C:/u/.claude/settings.json' }),
    ]) {
      assert.equal(decisionOf(payload), undefined, JSON.stringify(payload));
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
      /^teamrig secret guard: this call would print the content of \.env into the conversation\. .*secretGuard\.envNames or secretGuard\.commands\. Its command line holds a secret as text \(GitHub token, JSON web token\)\. Pass it by reference .*never as text\. \[secretGuard\.secretReads, secretGuard\.writes\]$/,
    );
  });

  it('says the secrets the written text holds last, after the other groups', () => {
    const reason = secretReason([
      { kind: 'written', id: 'jwt', description: 'JSON web token' },
      { kind: 'literal', id: 'github-token', description: 'GitHub token' },
    ]);
    assert.match(reason, /^teamrig secret guard: this call's command line holds a secret as text \(GitHub token\)\. .*never as text\. The text this call writes holds a secret \(JSON web token\)\. Keep a real one .*so no file holds it whole\. \[secretGuard\.writes\]$/);
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

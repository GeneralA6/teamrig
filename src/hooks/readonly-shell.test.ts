import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_GUARD } from '../config/defaults.ts';
import { NO_SNAPSHOT } from '../readonly-shell/snapshot.ts';
import { secretRulesOf } from '../secret-guard/rules.ts';
import { READONLY_REASON, readonlyRulesOf, readonlyShellOutput, type PrintsSecret } from './readonly-shell.ts';
import { secretFindingsOf } from './secret-guard.ts';

const CONFIG = { enabled: true, allowPrefixes: ['npx tsc --noEmit'] };
const RULES = readonlyRulesOf(CONFIG, { PATH: '/bin', npm_config_prefix: '/u/npm' }, NO_SNAPSHOT);

const call = (tool_name: string, command: unknown) => ({ tool_name, tool_input: { command } });

const NO_SECRET: PrintsSecret = () => false;

const ALLOW = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: READONLY_REASON },
});

describe('readonlyRulesOf', () => {
  it("splits the team's prefixes into words and takes the environment's names as exported", () => {
    assert.deepEqual(RULES.prefixes, [['npx', 'tsc', '--noEmit']]);
    assert.deepEqual([...RULES.exported], ['PATH', 'npm_config_prefix']);
    assert.equal(RULES.exportsAll, false);
  });

  it("adds the names the shell snapshot exports, and its set -a", () => {
    const rules = readonlyRulesOf(CONFIG, { PATH: '/bin' }, { names: new Set(['PATH', 'pod']), all: true });
    assert.deepEqual([...rules.exported], ['PATH', 'pod']);
    assert.equal(rules.exportsAll, true);
  });
});

describe('readonlyShellOutput', () => {
  it('allows a line that only reads, in the dialect of the tool that runs it', () => {
    assert.equal(readonlyShellOutput(call('Bash', 'grep -n x src/a.ts | head -5'), RULES, NO_SECRET), ALLOW);
    assert.equal(readonlyShellOutput(call('PowerShell', 'Get-Content f | Select-Object -First 5'), RULES, NO_SECRET), ALLOW);
    assert.equal(readonlyShellOutput(call('Bash', 'npx tsc --noEmit -p tsconfig.json'), RULES, NO_SECRET), ALLOW);
  });

  it('prints nothing for a line that writes, or reads only in the other dialect', () => {
    assert.equal(readonlyShellOutput(call('Bash', 'grep x f > out.txt'), RULES, NO_SECRET), '');
    assert.equal(readonlyShellOutput(call('Bash', 'Get-Content f'), RULES, NO_SECRET), '');
    assert.equal(readonlyShellOutput(call('PowerShell', 'grep x f'), RULES, NO_SECRET), '');
  });

  it('prints nothing for a name the environment exports, which the line may not set', () => {
    assert.equal(readonlyShellOutput(call('Bash', 'npm_config_prefix=/tmp/x'), RULES, NO_SECRET), '');
    assert.equal(readonlyShellOutput(call('Bash', 'prefix=/tmp/x'), RULES, NO_SECRET), ALLOW);
  });

  it('prints nothing for another tool, a missing command or input that is not a payload', () => {
    assert.equal(readonlyShellOutput(call('Read', 'grep x f'), RULES, NO_SECRET), '');
    assert.equal(readonlyShellOutput(call('Bash', 7), RULES, NO_SECRET), '');
    assert.equal(readonlyShellOutput({ tool_name: 'Bash' }, RULES, NO_SECRET), '');
    assert.equal(readonlyShellOutput('grep x f', RULES, NO_SECRET), '');
  });

  it('never allows a line that prints a secret, whatever the secret guard decides', () => {
    const secrets = secretRulesOf(DEFAULT_SECRET_GUARD, 'C:/u', 'win32');
    const printsSecret: PrintsSecret = (payload) => secretFindingsOf(payload, 'C:/w', secrets).length > 0;
    assert.equal(readonlyShellOutput(call('Bash', 'cat .env'), RULES, printsSecret), '');
    assert.equal(readonlyShellOutput(call('PowerShell', 'Get-Content ~/.npmrc'), RULES, printsSecret), '');
    assert.equal(readonlyShellOutput(call('Bash', 'cat .env | wc -c'), RULES, printsSecret), ALLOW);
  });
});

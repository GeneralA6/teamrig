import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { READONLY_REASON, readonlyRulesOf, readonlyShellOutput } from './readonly-shell.ts';

const RULES = readonlyRulesOf({ enabled: true, allowPrefixes: ['npx tsc --noEmit'] }, { PATH: '/bin', npm_config_prefix: '/u/npm' });

const call = (tool_name: string, command: unknown) => ({ tool_name, tool_input: { command } });

const ALLOW = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: READONLY_REASON },
});

describe('readonlyRulesOf', () => {
  it("splits the team's prefixes into words and takes the environment's names as exported", () => {
    assert.deepEqual(RULES.prefixes, [['npx', 'tsc', '--noEmit']]);
    assert.deepEqual([...RULES.exported], ['PATH', 'npm_config_prefix']);
  });
});

describe('readonlyShellOutput', () => {
  it('allows a line that only reads, in the dialect of the tool that runs it', () => {
    assert.equal(readonlyShellOutput(call('Bash', 'grep -n x src/a.ts | head -5'), RULES), ALLOW);
    assert.equal(readonlyShellOutput(call('PowerShell', 'Get-Content f | Select-Object -First 5'), RULES), ALLOW);
    assert.equal(readonlyShellOutput(call('Bash', 'npx tsc --noEmit -p tsconfig.json'), RULES), ALLOW);
  });

  it('prints nothing for a line that writes, or reads only in the other dialect', () => {
    assert.equal(readonlyShellOutput(call('Bash', 'grep x f > out.txt'), RULES), '');
    assert.equal(readonlyShellOutput(call('Bash', 'Get-Content f'), RULES), '');
    assert.equal(readonlyShellOutput(call('PowerShell', 'grep x f'), RULES), '');
  });

  it('prints nothing for a name the environment exports, which the line may not set', () => {
    assert.equal(readonlyShellOutput(call('Bash', 'npm_config_prefix=/tmp/x'), RULES), '');
    assert.equal(readonlyShellOutput(call('Bash', 'prefix=/tmp/x'), RULES), ALLOW);
  });

  it('prints nothing for another tool, a missing command or input that is not a payload', () => {
    assert.equal(readonlyShellOutput(call('Read', 'grep x f'), RULES), '');
    assert.equal(readonlyShellOutput(call('Bash', 7), RULES), '');
    assert.equal(readonlyShellOutput({ tool_name: 'Bash' }, RULES), '');
    assert.equal(readonlyShellOutput('grep x f', RULES), '');
  });
});

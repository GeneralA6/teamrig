import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { missingCliLine, missingCliOf, missingCliOutput } from './missing-cli.ts';

function succeeded(toolResponse: unknown, toolName = 'Bash'): unknown {
  return { hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: { command: 'teamrig list | head' }, tool_response: toolResponse };
}

function failed(error: string, toolName = 'Bash'): unknown {
  return { hook_event_name: 'PostToolUseFailure', tool_name: toolName, tool_input: { command: 'teamrig list' }, error };
}

describe('missingCliOf', () => {
  it('reads a failed shell call whose error says the bare command was not found', () => {
    assert.equal(missingCliOf(failed('Exit code 127\n/usr/bin/bash: line 1: teamrig: command not found')), 'PostToolUseFailure');
  });

  it('reads a piped call that exits 0 with the not-found line on stdout or stderr, or as the result text', () => {
    assert.equal(missingCliOf(succeeded({ stdout: '', stderr: 'bash: teamrig: command not found' })), 'PostToolUse');
    assert.equal(missingCliOf(succeeded({ stdout: 'bash: teamrig: command not found\n', stderr: '' })), 'PostToolUse');
    assert.equal(missingCliOf(succeeded('bash: teamrig: command not found')), 'PostToolUse');
  });

  it('knows what sh, zsh, fish, PowerShell and cmd print', () => {
    for (const text of [
      'sh: 1: teamrig: not found',
      'zsh: command not found: teamrig',
      'fish: Unknown command: teamrig',
      "teamrig : The term 'teamrig' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      "'teamrig' is not recognized as an internal or external command,",
    ]) {
      assert.equal(missingCliOf(failed(text, 'PowerShell')), 'PostToolUseFailure', text);
    }
  });

  it('ignores another command, a path or a longer name that is not found', () => {
    for (const text of [
      'bash: jq: command not found',
      'bash: ./bin/teamrig: command not found',
      'bash: my-teamrig: command not found',
      'zsh: command not found: teamrig-pane',
      'teamrig: no such task T1',
    ]) {
      assert.equal(missingCliOf(failed(text)), undefined, text);
    }
  });

  it('knows the line of a script, of zsh running one, and a line ending in a carriage return', () => {
    for (const text of ['./run.sh: line 3: teamrig: command not found', 'zsh:1: command not found: teamrig', 'out\r\nbash: teamrig: command not found\r\nmore']) {
      assert.equal(missingCliOf(succeeded({ stdout: text, stderr: '' })), 'PostToolUse', text);
    }
  });

  it('ignores output that quotes the not-found line inside its own text (T1186)', () => {
    for (const text of [
      "description: api's tab got 'teamrig: command not found' at 23:30 IDT",
      ' * the line a shell prints (`bash: teamrig: command not found`, `zsh: command not found: teamrig`),',
      '   "teamrig: command not found" (the description printed by `teamrig show`)',
      'T1186: bash: teamrig: command not found, then the fix',
      "the note says 'teamrig' is not recognized there",
    ]) {
      assert.equal(missingCliOf(succeeded({ stdout: text, stderr: '' })), undefined, text);
    }
  });

  it('ignores any other tool and any other event', () => {
    assert.equal(missingCliOf(succeeded('bash: teamrig: command not found', 'Read')), undefined);
    assert.equal(missingCliOf({ hook_event_name: 'PreToolUse', tool_name: 'Bash', error: 'bash: teamrig: command not found' }), undefined);
    assert.equal(missingCliOf('bash: teamrig: command not found'), undefined);
    assert.equal(missingCliOf(succeeded(undefined)), undefined);
  });
});

describe('missingCliLine', () => {
  it('names the copy the hooks run, by a path both shells take, and the reload that brings the bare name back', () => {
    const line = missingCliLine(String.raw`C:\plugins\teamrig\0.9.0\dist\cli\main.js`, 'teamrig');
    assert.ok(line.startsWith('teamrig: the shell did not find the bare `teamrig` command'));
    assert.ok(line.includes('run the installed copy by its path: `node "C:/plugins/teamrig/0.9.0/dist/cli/main.js" <command> ...`'));
    assert.ok(line.includes('never another copy from the plugin cache'));
    assert.ok(line.endsWith("The user's /reload-plugins brings the bare name back."));
  });

  it('hands the line to the model under the event it answers', () => {
    assert.deepEqual(JSON.parse(missingCliOutput('PostToolUseFailure', 'the line')), {
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'the line' },
    });
  });
});

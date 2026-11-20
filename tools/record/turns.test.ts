import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEALED_ENV, turnsOf } from './turns.ts';

const SESSION = '00000000-0000-4000-8000-000000000001';
const SEALED = ['--plugin-dir', '/rec/plugin', '--setting-sources', 'project', '--strict-mcp-config', '--model', 'haiku'];

function turns(platform: NodeJS.Platform) {
  return turnsOf({ sessionId: SESSION, pluginDir: '/rec/plugin', model: 'haiku', platform });
}

/** The value that follows `flag` in a turn's arguments. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('turnsOf', () => {
  it('starts the session with the tools turn, resumes it for one prompt, then compacts it, each turn sealed', () => {
    const [tools, resume, compact, ...rest] = turns('linux');
    assert.deepEqual(rest, []);
    assert.equal(tools?.name, 'tools');
    assert.equal(valueOf(tools?.args ?? [], '--session-id'), SESSION);
    assert.deepEqual(resume, { name: 'resume', args: ['-p', 'Reply with the word again.', '--resume', SESSION, ...SEALED] });
    assert.deepEqual(compact, { name: 'compact', args: ['-p', '/compact', '--resume', SESSION, ...SEALED] });
    for (const turn of [tools, resume, compact]) {
      assert.deepEqual(turn?.args.slice(-SEALED.length), SEALED, turn?.name);
    }
  });

  it('asks the tools turn for one numbered step per tool, a failing shell call, a failing read and a helper', () => {
    const args = turns('linux')[0]?.args ?? [];
    const prompt = valueOf(args, '-p') ?? '';
    assert.equal(valueOf(args, '--allowedTools'), 'Write,Read,Edit,Grep,Glob,Bash,Agent');
    assert.deepEqual(
      prompt.split('\n').map((line) => line.replace(/^(\d+\. \w+).*$/, '$1')),
      [
        'Do these steps in order, one tool call per step; skip none and add none.',
        '1. Write',
        '2. Read',
        '3. Edit',
        '4. Grep',
        '5. Glob',
        '6. Run',
        '7. Run',
        '8. Read',
        '9. Start',
        'Then reply with the word done.',
      ],
    );
    assert.match(prompt, /^7\. Run the Bash command: exit 3 /m);
    assert.match(prompt, /^8\. Read the file missing\.txt /m);
    assert.doesNotMatch(prompt, /PowerShell/);
  });

  it('adds the PowerShell tool and its step on Windows only', () => {
    const args = turns('win32')[0]?.args ?? [];
    assert.equal(valueOf(args, '--allowedTools'), 'Write,Read,Edit,Grep,Glob,Bash,PowerShell,Agent');
    assert.match(valueOf(args, '-p') ?? '', /^7\. Run the PowerShell command: Write-Output recorded-powershell\.$/m);
    assert.match(valueOf(args, '-p') ?? '', /^10\. Start one Agent helper /m);
  });
});

describe('SEALED_ENV', () => {
  it('turns off the instruction files of the account that records', () => {
    assert.deepEqual(SEALED_ENV, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
  });
});

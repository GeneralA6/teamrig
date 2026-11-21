import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compoundOperator, launcherCommand, planInstall, planUninstall, statusLine } from './status-line.ts';

const LAUNCHER = 'C:\\Users\\me\\.teamrig\\bin\\statusline.mjs';
const OWN = 'node "C:/Users/me/.teamrig/bin/statusline.mjs"';
const THEIRS = 'node "C:/Users/me/.claude/scripts/statusline.cjs"';

describe('launcherCommand', () => {
  it('runs the launcher with Node, its path quoted with forward slashes', () => {
    assert.equal(launcherCommand(LAUNCHER), OWN);
    assert.equal(launcherCommand('/home/me/.teamrig/bin/statusline.mjs'), 'node "/home/me/.teamrig/bin/statusline.mjs"');
  });
});

describe('planInstall', () => {
  it('makes the launcher the status line when there is none, keeping the other settings', () => {
    assert.deepEqual(planInstall({ theme: 'dark' }, LAUNCHER), {
      ok: true,
      value: { settings: { theme: 'dark', statusLine: { type: 'command', command: OWN } }, before: undefined, after: OWN },
    });
  });

  it('puts the launcher in front of a status line already there, keeping its other fields', () => {
    const plan = planInstall({ statusLine: { type: 'command', command: THEIRS, padding: 1 } }, LAUNCHER);
    const after = `${OWN} --pass | ${THEIRS}`;
    assert.deepEqual(plan, { ok: true, value: { settings: { statusLine: { type: 'command', command: after, padding: 1 } }, before: THEIRS, after } });
  });

  it('changes nothing when the launcher is already the status line, alone or in front', () => {
    for (const command of [OWN, `${OWN} --pass | ${THEIRS}`]) {
      assert.deepEqual(planInstall({ statusLine: { type: 'command', command } }, LAUNCHER), {
        ok: true,
        value: { settings: undefined, before: command, after: command },
      });
    }
  });

  it('puts the bare launcher back when its --pass has nothing piped after it, keeping the other fields', () => {
    for (const command of [`${OWN} --pass`, `${OWN} --pass | `, `${OWN} --pass|`]) {
      assert.deepEqual(planInstall({ statusLine: { type: 'command', command, padding: 1 } }, LAUNCHER), {
        ok: true,
        value: { settings: { statusLine: { type: 'command', command: OWN, padding: 1 } }, before: command, after: OWN },
      });
    }
  });

  it('refuses a compound shell line and a status line without a command', () => {
    const compound = planInstall({ statusLine: { type: 'command', command: 'cd ~ && ./status.sh' } }, LAUNCHER);
    assert.equal(compound.ok, false);
    assert.match(compound.ok ? '' : compound.problem, /shell line with "&&"/);
    for (const statusLine of [{ type: 'command' }, 'node x.js']) {
      const plan = planInstall({ statusLine }, LAUNCHER);
      assert.deepEqual(plan, { ok: false, problem: 'statusLine has no command string, so nothing can be added in front of it' });
    }
  });
});

describe('planUninstall', () => {
  it('hands the status line back to the command that was there before', () => {
    const before = `${OWN} --pass | ${THEIRS}`;
    assert.deepEqual(planUninstall({ statusLine: { type: 'command', command: before, padding: 1 } }, LAUNCHER), {
      ok: true,
      value: { settings: { statusLine: { type: 'command', command: THEIRS, padding: 1 } }, before, after: THEIRS },
    });
  });

  it('removes the status line when the launcher was alone, or passed its input on to nothing', () => {
    for (const before of [OWN, `${OWN} --pass`, `${OWN} --pass | `]) {
      assert.deepEqual(planUninstall({ theme: 'dark', statusLine: { type: 'command', command: before } }, LAUNCHER), {
        ok: true,
        value: { settings: { theme: 'dark' }, before, after: undefined },
      });
    }
  });

  it('changes nothing when the launcher is not the status line', () => {
    for (const settings of [{}, { statusLine: { type: 'command', command: THEIRS } }]) {
      const before = settings.statusLine?.command;
      assert.deepEqual(planUninstall(settings, LAUNCHER), { ok: true, value: { settings: undefined, before, after: before } });
    }
  });

  it('refuses a launcher line changed by hand', () => {
    const plan = planUninstall({ statusLine: { type: 'command', command: `${OWN} --verbose` } }, LAUNCHER);
    assert.match(plan.ok ? '' : plan.problem, /changed by hand/);
  });
});

describe('statusLine', () => {
  const FULL = {
    session_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    transcript_path: 'C:\\Users\\me\\.claude\\projects\\p\\another-name.jsonl',
    cwd: '/elsewhere',
    workspace: { current_dir: '/work/repo' },
    agent: { name: 'alpha' },
    model: { id: 'model-id', display_name: 'Opus' },
    effort: { level: 'high' },
    cost: { total_cost_usd: 1.25 },
    context_window: { used_percentage: 42, total_input_tokens: 84_000 },
  };

  it('names the setting its plans change, and plans by planInstall and planUninstall', () => {
    assert.equal(statusLine.setting, 'statusLine');
    assert.deepEqual(statusLine.install({}, LAUNCHER), planInstall({}, LAUNCHER));
    const installed = { statusLine: { type: 'command', command: OWN } };
    assert.deepEqual(statusLine.uninstall(installed, LAUNCHER), planUninstall(installed, LAUNCHER));
  });

  it('reads every field the status input tells', () => {
    assert.deepEqual(statusLine.parse(`  ${JSON.stringify(FULL)}\n`), {
      sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      cwd: '/work/repo',
      agentName: 'alpha',
      model: 'Opus',
      effort: 'high',
      costUsd: 1.25,
      contextUsedPct: 42,
      contextInputTokens: 84_000,
    });
  });

  it('leaves a field the input did not tell undefined, the folder empty', () => {
    const bare = { sessionId: undefined, cwd: '', agentName: undefined, model: undefined, effort: undefined, costUsd: undefined, contextUsedPct: undefined, contextInputTokens: undefined };
    assert.deepEqual(statusLine.parse('{}'), bare);
    const blank = { agent: { name: ' ' }, model: { display_name: '' }, effort: { level: 3 }, cost: { total_cost_usd: '1' }, context_window: { used_percentage: Number.NaN } };
    assert.deepEqual(statusLine.parse(JSON.stringify(blank)), bare);
  });

  it("takes the session id from the transcript's file name when the input names none, and the folder from cwd", () => {
    for (const transcript_path of ['C:\\Users\\me\\.claude\\projects\\p\\abc-1.jsonl', '/u/.claude/projects/p/abc-1.jsonl']) {
      assert.deepEqual([statusLine.parse(JSON.stringify({ transcript_path, cwd: '/work' }))?.sessionId, statusLine.parse(JSON.stringify({ transcript_path, cwd: '/work' }))?.cwd], ['abc-1', '/work']);
    }
    assert.equal(statusLine.parse(JSON.stringify({ transcript_path: '/u/p/notes.txt' }))?.sessionId, 'notes.txt');
  });

  it('reads nothing from a text that is no JSON object', () => {
    for (const input of ['', 'not json', '[1]', '"text"', 'null']) {
      assert.equal(statusLine.parse(input), undefined, input);
    }
  });
});

describe('compoundOperator', () => {
  it('finds &&, ||, ; and line breaks outside quotes', () => {
    assert.equal(compoundOperator('a && b'), '"&&"');
    assert.equal(compoundOperator('a || b'), '"||"');
    assert.equal(compoundOperator('a; b'), '";"');
    assert.equal(compoundOperator('a\nb'), 'a line break');
  });

  it('allows pipes, redirects and operators inside quotes or escaped', () => {
    for (const command of ['jq -r .model | xargs echo', 'node x.js 2>&1', 'bash -c "a; b && c"', "sh -c 'a || b'", 'echo a\\;b', THEIRS]) {
      assert.equal(compoundOperator(command), undefined, command);
    }
  });
});

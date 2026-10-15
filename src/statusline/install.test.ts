import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compoundOperator, launcherCommand, planInstall, planUninstall } from './install.ts';

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

  it('removes the status line when the launcher was alone', () => {
    assert.deepEqual(planUninstall({ theme: 'dark', statusLine: { type: 'command', command: OWN } }, LAUNCHER), {
      ok: true,
      value: { settings: { theme: 'dark' }, before: OWN, after: undefined },
    });
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

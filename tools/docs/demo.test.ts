import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commandLine, DEMO_CONFIG, displayPaths, runDemo } from './demo.ts';

describe('commandLine', () => {
  it('prints plain arguments bare after teamrig', () => {
    assert.equal(commandLine(['set', 'T2', '--status', 'in-progress']), 'teamrig set T2 --status in-progress');
  });

  it('quotes an argument with spaces and escapes the characters a shell would read', () => {
    assert.equal(commandLine(['add', '--title', 'Saved card']), 'teamrig add --title "Saved card"');
    assert.equal(commandLine(['x', 'a "b" $c `d` \\e']), 'teamrig x "a \\"b\\" \\$c \\`d\\` \\\\e"');
  });
});

describe('displayPaths', () => {
  it('shows a path under the kit under ~/.teamrig', () => {
    assert.equal(displayPaths('INBOX: 1 unread line(s) in /kit/teams/t/inbox/web.md', '/kit'), 'INBOX: 1 unread line(s) in ~/.teamrig/teams/t/inbox/web.md');
  });

  it('turns a Windows path into forward slashes, written either way', () => {
    assert.equal(displayPaths('at C:\\kit\\teams\\a.md and C:/kit/b.md', 'C:\\kit'), 'at ~/.teamrig/teams/a.md and ~/.teamrig/b.md');
  });

  it('leaves a line without a kit path unchanged', () => {
    assert.equal(displayPaths('READ web: nothing new', '/kit'), 'READ web: nothing new');
  });

  it('treats the kit path literally, not as a pattern', () => {
    assert.equal(displayPaths('at /k.t/a and /kit/a', '/k.t'), 'at ~/.teamrig/a and /kit/a');
  });
});

describe('runDemo', () => {
  it('runs each step as its session and records what the CLI printed', async () => {
    const runs = await runDemo([
      { session: 'lead', argv: ['add', '--title', 'Saved-card API', '--tier', '1', '--owner', 'api'] },
      { session: 'api', argv: ['set', 'T1', '--status', 'in-progress'] },
    ]);
    assert.deepEqual(
      runs.map((run) => [run.session, run.command]),
      [
        ['lead', 'teamrig add --title "Saved-card API" --tier 1 --owner api'],
        ['api', 'teamrig set T1 --status in-progress'],
      ],
    );
    assert.match(runs[0]?.output.join('\n') ?? '', /^ADDED T1 open, tier 1, owner api,/);
    assert.match(runs[1]?.output.join('\n') ?? '', /^SET T1 in-progress, tier 1, owner api,/);
  });

  it('moves the clock three minutes per step and shows kit paths under ~/.teamrig', async () => {
    const runs = await runDemo([
      { session: 'lead', argv: ['add', '--title', 'A', '--tier', '2', '--owner', 'web'] },
      { session: 'lead', argv: ['inbox', 'add', '--to', 'web', '--text', 'go'] },
      { session: 'web', argv: ['inbox', 'read'] },
    ]);
    assert.match(runs[1]?.output[0] ?? '', /^POSTED to web; web is reminded at its next prompt$/);
    assert.equal(runs[2]?.output[0], '- 2026-10-12 09:03 lead: go');
  });

  it('draws the same output on every run', async () => {
    const steps = [{ session: 'lead', argv: ['add', '--title', 'A', '--tier', '2', '--owner', 'web'] }];
    assert.deepEqual(await runDemo(steps), await runDemo(steps));
  });

  it('throws on a step that fails, naming it and its session', async () => {
    await assert.rejects(runDemo([{ session: 'web', argv: ['set', 'T9', '--status', 'done'] }]), /^Error: demo step "teamrig set T9 --status done" as web exited [1-9]/);
  });

  it('runs against the team config it is given', async () => {
    const config = { ...DEMO_CONFIG, sessions: ['lead', 'ops'] };
    const runs = await runDemo([{ session: 'lead', argv: ['add', '--title', 'A', '--tier', '2', '--owner', 'ops'] }], config);
    assert.match(runs[0]?.output[0] ?? '', /^ADDED T1 open, tier 2, owner ops,/);
    await assert.rejects(runDemo([{ session: 'lead', argv: ['add', '--title', 'A', '--tier', '2', '--owner', 'ops'] }]), /exited/);
  });
});

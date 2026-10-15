import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, RENAMES_PATH, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const MARKS_PATH = join(TEAM_HOME, 'state', 'inbox-marks.jsonl');
const HINTS_PATH = join(TEAM_HOME, 'state', 'bind-hints.jsonl');
const WEB_PROJECT = resolve('/', 'work', 'web');
const AS_CLAUDE = { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION };

function prompt(fields: JsonRecord = {}): string {
  return JSON.stringify({ cwd: APP, session_id: CLAUDE_SESSION, ...fields });
}

describe('runCli: a hand-started tab binds itself by its Claude Code title (T302)', () => {
  it('binds a tab titled by its id, renames nothing, marks nothing read, and shows its lines', async () => {
    const kit = new CliHarness();
    await kit.run(['inbox', 'add', '--to', 'alpha', '--text', 'T7 is yours', '--session', 'lead']);
    const result = await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'alpha' }) });
    assert.equal(result.code, EXIT.ok);
    assert.equal(result.stdout[0], 'teamrig: this tab is now the `alpha` session of team app (name `app-alpha`), from its Claude Code title; nothing was marked read.');
    assert.match(result.stdout[1] ?? '', /^INBOX alpha, new in .*\n- 2030-01-08 10:00 lead: T7 is yours$/);
    assert.equal(result.stdout.length, 2);
    assert.equal(await kit.files.read(RENAMES_PATH), undefined);
    assert.match((await kit.run(['inbox', 'status', '--session', 'alpha'])).stdout[0] ?? '', /^alpha 1 unread .*\(read to line 0 of 1 at 01-08 10:00\)$/);

    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'alpha' }) })).stdout, []);
    assert.ok(contextOf(await kit.run(['hook', 'session-start'], { stdin: prompt({ source: 'resume' }) })).includes('You are the `alpha` session of team `app`'));
  });

  it('binds at SessionStart by the current name, keeping the read position, and says so', async () => {
    const kit = new CliHarness({ ...TEAM, names: { lead: 'team-lead' } });
    await kit.run(['inbox', 'add', '--to', 'lead', '--text', 'old news', '--session', 'alpha']);
    await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-1111-2222-3333-444455556666' } });
    const text = contextOf(await kit.run(['hook', 'session-start'], { stdin: prompt({ session_title: 'team-lead', source: 'startup' }) }));
    assert.ok(text.includes('You are the `lead` session of team `app` (name `team-lead`, roles: lead).'), text);
    assert.ok(text.includes('This tab was bound to the `lead` session from its Claude Code title; nothing was marked read.'), text);
    assert.match((await kit.run(['inbox', 'status', '--session', 'lead'])).stdout[0] ?? '', /^lead 0 unread \(read to line 1 of 1/);
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'team-lead' }) })).stdout, []);
  });

  it('says once per reason how to bind a tab it cannot bind, until a rename binds it', async () => {
    const kit = new CliHarness();
    const untitled = await kit.run(['hook', 'inbox-reminder'], { stdin: prompt() });
    assert.deepEqual(untitled.stdout, [
      "teamrig: this tab is not bound to a session of team app. To bind it, /rename the tab to its session's id or name, or run `teamrig inbox read --session <id>` (ids: lead, alpha, bravo).",
    ]);
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin: prompt() })).stdout, []);
    const unmatched = await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'Fix it' }) });
    assert.match(unmatched.stdout[0] ?? '', /^teamrig: this tab's title "Fix it" names no session of team app, so it is not bound\./);
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'Fix it' }) })).stdout, []);
    assert.equal((await kit.files.read(HINTS_PATH))?.trim().split('\n').length, 2);

    const bound = await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'app-bravo' }) });
    assert.deepEqual(bound.stdout, ['teamrig: this tab is now the `bravo` session of team app (name `app-bravo`), from its Claude Code title; nothing was marked read.']);
  });

  it('binds nothing when the title names a session of another team of the tree too', async () => {
    const kit = await treeHarness();
    const result = await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'lead' }) });
    assert.match(result.stdout[0] ?? '', /title "lead" names app\/lead and ops\/lead and ui\/lead and web\/lead, so it is not bound\. To bind it, \/rename the tab to the session's name/);
    assert.equal(await kit.files.read(MARKS_PATH), undefined);
    assert.match((await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'front' }) })).stdout[0] ?? '', /"front" names no session of team app/);
    assert.match((await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'app-lead' }) })).stdout[0] ?? '', /now the `lead` session of team app/);
  });

  it('never binds over $TEAMRIG_SESSION or an inbox read', async () => {
    const kit = new CliHarness();
    await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'bravo' }), env: { TEAMRIG_SESSION: 'alpha' } });
    assert.equal(await kit.files.read(MARKS_PATH), undefined);
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: AS_CLAUDE });
    const result = await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'lead' }) });
    assert.ok(!result.stdout.some((line) => line.includes('this tab is now')), result.stdout.join('\n'));
    assert.equal((await kit.files.read(MARKS_PATH))?.trim().split('\n').length, 1);
  });

  it('says the tab could not be bound, and answers, when the mark cannot be written', async () => {
    const kit = new CliHarness();
    const files = new FaultyFiles(kit.files).fail('append', MARKS_PATH, systemError('EACCES', 'EACCES: permission denied'));
    const result = await kit.run(['hook', 'inbox-reminder'], { stdin: prompt({ session_title: 'alpha' }), files });
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['teamrig: this tab could not be bound by its title (EACCES: permission denied); the next prompt tries again.']]);
    const start = await kit.run(['hook', 'session-start'], { stdin: prompt({ session_title: 'alpha' }), files });
    assert.ok(contextOf(start).includes('No session is set'));
  });

  it('marks read, without printing again, the lines the prompt hook already showed the tab', async () => {
    const kit = new CliHarness();
    const env = { TEAMRIG_SESSION: 'bravo', ...AS_CLAUDE };
    for (const text of ['first', 'second']) {
      await kit.run(['inbox', 'add', '--to', 'bravo', '--text', text, '--session', 'lead']);
    }
    assert.match((await kit.run(['hook', 'inbox-reminder'], { stdin: prompt(), env })).stdout[0] ?? '', /lead: first\n.*lead: second$/);
    await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'third', '--session', 'lead']);
    const read = await kit.run(['inbox', 'read'], { env });
    assert.deepEqual(read.stdout, [
      '- 2030-01-08 10:00 lead: third',
      'READ bravo: 1 new line, shown above, and 2 the prompt hook showed this session, now marked read too; new ones are shown at your next prompt',
    ]);
  });
});

describe('runCli: a session hook reads the team of the folder the session started in', () => {
  it('keeps the team of $CLAUDE_PROJECT_DIR when the session moved into another team\'s project', async () => {
    const kit = await treeHarness();
    await kit.files.write(join(WEB_PROJECT, '.teamrig.json'), '{"team": "web"}');
    const moved = prompt({ cwd: WEB_PROJECT, session_title: 'app-alpha' });
    const result = await kit.run(['hook', 'inbox-reminder'], { stdin: moved, cwd: WEB_PROJECT, env: { CLAUDE_PROJECT_DIR: APP } });
    assert.match(result.stdout[0] ?? '', /now the `alpha` session of team app/);
    const start = await kit.run(['hook', 'session-start'], { stdin: moved, cwd: WEB_PROJECT, env: { CLAUDE_PROJECT_DIR: APP } });
    assert.ok(contextOf(start).includes('You are the `alpha` session of team `app`'));

    const fresh = await treeHarness();
    await fresh.files.write(join(WEB_PROJECT, '.teamrig.json'), '{"team": "web"}');
    const unset = await fresh.run(['hook', 'inbox-reminder'], { stdin: moved, cwd: WEB_PROJECT });
    assert.match(unset.stdout[0] ?? '', /"app-alpha" names no session of team web/, 'without the start folder, the payload folder decides');
  });
});

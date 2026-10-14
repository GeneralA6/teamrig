import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type { ConfigFormat } from '../config/migrate.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { KIT_VERSION } from '../core/version.ts';
import { APP, bash, CLAUDE_SESSION, CliHarness, CONFIG_PATH, contextOf, decisionOf, EVENTS_PATH, KIT, POINTER, SKILLS_DIR, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** A release one config version ahead: version 2, reached from 1 by a step that changes only the version. */
const NEXT_FORMAT: ConfigFormat = { version: 2, migrations: [{ from: 1, apply: (config) => ({ config, changes: ['added a flag'] }) }] };

describe('runCli: commits check', () => {
  const stat = (letter: string, lines: number, body = '') => ({
    sha: letter.repeat(40),
    subject: `Change ${letter}`,
    body,
    files: [{ path: 'src/a.ts', added: lines, deleted: 0 }],
  });

  it('passes a range within the rule, reading HEAD by default', async () => {
    const kit = new CliHarness();
    const ranges: string[] = [];
    const commitLog = {
      between: (dir: string, base: string, tip: string) => {
        ranges.push(`${dir} ${base}..${tip}`);
        return [stat('a', 10), stat('b', 900, 'Large-commit: generated')];
      },
    };
    const result = await kit.run(['commits', 'check', '--base', 'origin/main'], { commitLog });
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, ['OK 2 commit(s) in origin/main..HEAD, none over 400 non-test lines or 15 files without a reason']);
    assert.deepEqual(ranges, [`${APP} origin/main..HEAD`]);
  });

  it("refuses a range with a large commit, by the team's bounds", async () => {
    const kit = new CliHarness({ ...TEAM, commits: { maxLines: 100 } });
    const result = await kit.run(['commits', 'check', '--base', 'main', '--tip', 'feature'], { commitLog: { between: () => [stat('c', 101)] } });
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout.join('\n'), /^REFUSED 1 commit\(s\) go over 100 changed non-test lines .*ccccccc "Change c" \(101 line\(s\), 1 file\(s\)\)/);
  });

  it('fails when git cannot list the range, and needs --base', async () => {
    const kit = new CliHarness();
    const failed = await kit.run(['commits', 'check', '--base', 'nope'], { commitLog: { between: () => undefined } });
    assert.equal(failed.code, EXIT.failed);
    assert.match(failed.stderr.join('\n'), /git cannot list the commits in nope\.\.HEAD/);
    assert.equal((await kit.run(['commits', 'check'])).code, EXIT.usage);
  });
});

describe('runCli: help, version and usage errors', () => {
  it('prints the usage for help, and exits 64 with no command', async () => {
    const kit = new CliHarness();
    const help = await kit.run(['--help']);
    assert.equal(help.code, EXIT.ok);
    assert.match(help.stdout.join('\n'), /^teamrig <command>/);
    assert.equal((await kit.run([])).code, EXIT.usage);
  });

  it('prints the version', async () => {
    assert.deepEqual((await new CliHarness().run(['--version'])).stdout, [`teamrig ${KIT_VERSION}`]);
  });

  it('exits 64 with the reason and the usage on a line it cannot read', async () => {
    const result = await new CliHarness().run(['add', '--titel', 'x', '--session', 'alpha']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /^add takes no --titel\n\nteamrig <command>/);
  });
});

describe('runCli: the task register', () => {
  it('adds, lists, sets and shows a task', async () => {
    const kit = new CliHarness();
    const added = await kit.run(['add', '--title', 'Ship the CLI', '--tier', '2', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    assert.match(added.stdout[0] ?? '', /^ADDED T1 open, tier 2, owner alpha, from \S+ \| /);

    const listed = await kit.run(['list'], { env: { TEAMRIG_SESSION: 'alpha' } });
    assert.equal(listed.code, EXIT.ok);
    assert.match(listed.stdout.join('\n'), /^T1 open, tier 2, owner alpha,/m);

    const set = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
    assert.match(set.stdout[0] ?? '', /^SET T1 in-progress, tier 2, owner alpha,/);

    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.equal(shown.code, EXIT.ok);
    assert.match(shown.stdout.join('\n'), /Ship the CLI/);
  });

  it('exits 2 with REFUSED when a team rule refuses a write', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--tier', '2', '--session', 'alpha']);
    const notOwner = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'bravo']);
    assert.equal(notOwner.code, EXIT.refused);
    assert.deepEqual(notOwner.stdout, ['REFUSED only the owner (alpha) sets the status of T1']);

    const noSkill = await kit.run(['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc123', '--session', 'alpha']);
    assert.equal(noSkill.code, EXIT.refused);
    assert.match(noSkill.stdout[0] ?? '', /^REFUSED done needs --skill/);

    const done = await kit.run(['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc123', '--skill', 'none', '--session', 'alpha']);
    assert.equal(done.code, EXIT.ok, done.stdout.join('\n'));
  });

  it('refuses everything without a team config', async () => {
    const result = await new CliHarness(null).run(['list', '--session', 'alpha']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /^REFUSED no team config at /);
  });

  it('reads through a config with problems but refuses to write through it', async () => {
    const kit = new CliHarness({ ...TEAM, pushGuard: { protectedBranches: 'main' } });
    const listed = await kit.run(['list', '--session', 'alpha']);
    assert.equal(listed.code, EXIT.ok);
    assert.match(listed.stderr[0] ?? '', /^WARN config: 1 problem\(s\), defaults used \(first: pushGuard.protectedBranches/);

    const added = await kit.run(['add', '--title', 'x', '--tier', '1', '--session', 'alpha']);
    assert.equal(added.code, EXIT.refused);
    assert.match(added.stdout[0] ?? '', /^REFUSED the team config has 1 problem\(s\)/);
  });

  it('reads a config from a newer teamrig best-effort but never writes through it', async () => {
    const kit = new CliHarness({ ...TEAM, configVersion: 99 });
    const listed = await kit.run(['list', '--session', 'alpha']);
    assert.equal(listed.code, EXIT.ok);
    assert.match(listed.stderr[0] ?? '', /config version 99, from a newer teamrig/);
    assert.equal((await kit.run(['add', '--title', 'x', '--tier', '1', '--session', 'alpha'])).code, EXIT.refused);
  });

  it('updates a task, reading the new owner as a session', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--tier', '2', '--session', 'alpha']);
    const updated = await kit.run(['update', 'T1', '--owner', 'bravo', '--note', 'bravo takes it', '--session', 'alpha']);
    assert.equal(updated.code, EXIT.ok, updated.stdout.join('\n'));
    assert.match(updated.stdout[0] ?? '', /^UPDATED T1 open, tier 2, owner bravo,/);
    const retitled = await kit.run(['update', 'T1', '--title', 'Ship the CLI twice', '--session', 'bravo']);
    assert.equal(retitled.code, EXIT.ok, retitled.stdout.join('\n'));
    assert.match(retitled.stdout[0] ?? '', /Ship the CLI twice/);
  });

  it('refuses to show a task it does not hold', async () => {
    const result = await new CliHarness().run(['show', 'T9', '--session', 'alpha']);
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, ['REFUSED no task T9']]);
  });

  it('names damaged lines on stderr and still reads the rest', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--tier', '2', '--session', 'alpha']);
    await kit.files.append(EVENTS_PATH, '{ torn\n');
    const listed = await kit.run(['list', '--session', 'alpha']);
    assert.equal(listed.code, EXIT.ok);
    assert.match(listed.stdout.join('\n'), /^T1 open, tier 2, owner alpha,/m);
    assert.deepEqual(listed.stderr, [`WARN ${EVENTS_PATH}: 1 unreadable line(s), 0 line(s) from a newer teamrig, 0 event(s) naming no task`]);
  });

  it('reports a disk error it cannot handle as FAILED and exits 1', async () => {
    const kit = new CliHarness();
    const files = new FaultyFiles(kit.files).fail('read', EVENTS_PATH, systemError('EACCES'));
    const result = await kit.run(['list', '--session', 'alpha'], { files });
    assert.deepEqual([result.code, result.stdout, result.stderr], [EXIT.failed, [], ['FAILED EACCES: simulated']]);
  });

  it('checks the week plan and the skills, and skips the week checks before any plan', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--tier', '2', '--due', '2030-01-10', '--session', 'alpha']);
    await kit.files.write(join(SKILLS_DIR, 'alpha-demo', 'SKILL.md'), 'no frontmatter\n');

    const bare = await kit.run(['check', '--session', 'alpha']);
    assert.equal(bare.code, EXIT.ok);
    assert.equal(bare.stdout[0], 'CHECK 0 flag(s), no week plan tagged yet, so the week checks are skipped');

    const weekly = await kit.run(['check', '--week', '2030-01-07', '--session', 'alpha']);
    assert.equal(weekly.code, EXIT.ok);
    assert.equal(weekly.stdout[0], 'CHECK 1 flag(s), week 2030-01-07');
    assert.match(weekly.stdout[1] ?? '', /DUE-UNPLANNED/);
    const skills = weekly.stdout.findIndex((line) => line.startsWith('SKILLS '));
    assert.match(weekly.stdout[skills] ?? '', /^SKILLS [1-9]\d* flag\(s\) in /);
    assert.match(weekly.stdout[skills + 1] ?? '', /alpha-demo/);
  });

  it('plans the newest started week, or the one given, and refuses before any plan', async () => {
    const kit = new CliHarness();
    const none = await kit.run(['plan', '--session', 'alpha']);
    assert.deepEqual([none.code, none.stdout], [EXIT.refused, ['REFUSED no week plan tagged yet; pass --week <YYYY-MM-DD>']]);

    await kit.run(['add', '--title', 'Ship the CLI', '--tier', '1', '--week', '2030-01-07', '--session', 'alpha']);
    const current = await kit.run(['plan', '--session', 'alpha']);
    assert.equal(current.code, EXIT.ok);
    assert.match(current.stdout.join('\n'), /2030-01-07[\s\S]*Ship the CLI/);
    const given = await kit.run(['plan', '--week', '2030-01-07', '--session', 'alpha']);
    assert.deepEqual(given.stdout, current.stdout);
  });
});

describe('runCli: config', () => {
  it('validates a good config', async () => {
    const result = await new CliHarness().run(['config', 'validate']);
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, [`VALID ${CONFIG_PATH}`]]);
  });

  it('lists every problem and exits 1', async () => {
    const result = await new CliHarness({ ...TEAM, pushGuard: { protectedBranches: 'main' } }).run(['config', 'validate']);
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stdout[0] ?? '', /^INVALID .*: 1 problem\(s\)/);
    assert.match(result.stdout[1] ?? '', /^ {2}pushGuard.protectedBranches: /);
  });

  it('reports a config it cannot read at all', async () => {
    const result = await new CliHarness('{ not json').run(['config', 'validate']);
    assert.equal(result.code, EXIT.failed);
    assert.equal(result.stdout[0], `INVALID ${CONFIG_PATH}`);
    assert.equal((await new CliHarness(null).run(['config', 'validate'])).code, EXIT.refused);
  });

  it('leaves a current config alone and refuses to migrate a newer one', async () => {
    const current = await new CliHarness().run(['config', 'migrate']);
    assert.deepEqual([current.code, current.stdout], [EXIT.ok, [`UNCHANGED ${CONFIG_PATH} needs no migration`]]);
    const newer = await new CliHarness({ ...TEAM, configVersion: 99 }).run(['config', 'migrate']);
    assert.equal(newer.code, EXIT.refused);
    assert.match(newer.stdout[0] ?? '', /^REFUSED .*config version 99, from a newer teamrig; update teamrig instead$/);
  });

  it('notes a config from a newer teamrig and validates the fields it knows', async () => {
    const result = await new CliHarness({ ...TEAM, configVersion: 99 }).run(['config', 'validate']);
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, [
      'NOTE config version 99 is from a newer teamrig: only the fields this one knows are checked',
      `VALID ${CONFIG_PATH}`,
    ]);
  });

  it('notes an older config, then migrates it and keeps the old file', async () => {
    const kit = new CliHarness();
    const validated = await kit.run(['config', 'validate'], { configFormat: NEXT_FORMAT });
    assert.equal(validated.code, EXIT.ok);
    assert.deepEqual(validated.stdout, ['NOTE config version 1 is older than 2; run: teamrig config migrate', `VALID ${CONFIG_PATH}`]);

    const migrated = await kit.run(['config', 'migrate'], { configFormat: NEXT_FORMAT });
    assert.equal(migrated.code, EXIT.ok, migrated.stdout.join('\n'));
    assert.match(migrated.stdout[0] ?? '', /^MIGRATED .* from version 1 to 2; the old file is at .*config\.v1\.json$/);
    assert.deepEqual(migrated.stdout.slice(1), ['  v1→v2: added a flag']);
    assert.match(kit.files.get(CONFIG_PATH) ?? '', /"configVersion": 2/);

    const again = await kit.run(['config', 'migrate'], { configFormat: NEXT_FORMAT });
    assert.deepEqual(again.stdout, [`UNCHANGED ${CONFIG_PATH} needs no migration`]);
  });
});

describe('runCli: session names', () => {
  const NAMED: JsonRecord = { ...TEAM, names: { lead: 'team-lead' }, roles: { lead: 'lead', coordinatorOwner: 'alpha' } };

  it('takes a name wherever it takes a session, and keys everything by id', async () => {
    const kit = new CliHarness(NAMED);
    const posted = await kit.run(['inbox', 'add', '--to', 'team-lead', '--text', 'ready', '--session', 'app-alpha']);
    assert.match(posted.stdout[0] ?? '', /^POSTED to lead; lead is reminded at its next prompt$/);
    const read = await kit.run(['inbox', 'read', '--session', 'team-lead']);
    assert.deepEqual(read.stdout[0], '- 2030-01-08 10:00 alpha: ready');

    const added = await kit.run(['add', '--title', 'Ship the names', '--tier', '2', '--owner', 'app-bravo', '--session', 'team-lead']);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    const byName = await kit.run(['list', '--session', 'app-bravo']);
    assert.deepEqual(byName.stdout, (await kit.run(['list', '--session', 'bravo'])).stdout);
    assert.equal(byName.stdout.length, 1);
    const set = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'app-bravo']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
  });

  it('refuses a name the team does not use', async () => {
    const result = await new CliHarness(NAMED).run(['inbox', 'add', '--to', 'app-lead', '--text', 'hi', '--session', 'alpha']);
    assert.deepEqual(
      [result.code, result.stdout[0]],
      [EXIT.refused, 'REFUSED app-lead is not a session on this team (sessions: lead (team-lead), alpha (app-alpha), bravo (app-bravo))'],
    );
  });

  it('still filters by the id of a session no longer on the team, but not by an unknown name', async () => {
    const kit = new CliHarness(NAMED);
    assert.deepEqual(await kit.run(['list', '--session', 'zulu']), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.match((await kit.run(['inbox', 'status', '--session', 'zulu'])).stdout[0] ?? '', /^INBOX no inbox for zulu in /);
    const long = await kit.run(['list', '--session', 'app-a-name-longer-than-any-session-id']);
    assert.equal(long.code, EXIT.refused);
  });

  it('prints who to message, by id, name or role, or the whole roster', async () => {
    const kit = new CliHarness(NAMED);
    const names = await Promise.all(['lead', 'team-lead', 'coordinatorOwner', 'bravo'].map((text) => kit.run(['who', text])));
    assert.deepEqual(
      names.map((result) => result.stdout),
      [['team-lead'], ['team-lead'], ['app-alpha'], ['app-bravo']],
    );
    assert.deepEqual((await kit.run(['who'])).stdout, ['lead team-lead (lead)', 'alpha app-alpha (coordinatorOwner)', 'bravo app-bravo']);
  });

  it('refuses who for a role nobody holds or a stranger', async () => {
    const kit = new CliHarness();
    const role = await kit.run(['who', 'coordinatorOwner']);
    assert.deepEqual([role.code, role.stdout[0]], [EXIT.refused, 'REFUSED no session holds the coordinatorOwner role']);
    assert.equal((await kit.run(['who', 'zulu'])).code, EXIT.refused);
    assert.equal((await kit.run(['who', 'a', 'b'])).code, EXIT.usage);
  });
});

describe('runCli: inboxes', () => {
  it('posts a line, reads it once, then has nothing new', async () => {
    const kit = new CliHarness();
    const posted = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'the build is green', '--session', 'alpha']);
    assert.equal(posted.code, EXIT.ok, posted.stdout.join('\n'));
    assert.match(posted.stdout[0] ?? '', /^POSTED to bravo; bravo is reminded at its next prompt$/);

    const status = await kit.run(['inbox', 'status']);
    assert.match(status.stdout.join('\n'), /bravo/);

    const first = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.equal(first.code, EXIT.ok);
    assert.deepEqual(first.stdout.slice(0, 1), ['- 2030-01-08 10:00 alpha: the build is green']);
    assert.match(first.stdout[1] ?? '', /^READ bravo: 1 new line, shown above; /);

    const again = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.match(again.stdout[0] ?? '', /^READ bravo: nothing new/);
  });

  it('refuses a line to or from someone outside the team, and reading their inbox', async () => {
    const kit = new CliHarness();
    const result = await kit.run(['inbox', 'add', '--to', 'zulu', '--text', 'hi', '--session', 'alpha']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /^REFUSED zulu is not a session on this team/);
    const read = await kit.run(['inbox', 'read', '--session', 'zulu']);
    assert.deepEqual(
      [read.code, read.stdout[0]],
      [EXIT.refused, 'REFUSED zulu is not a session on this team (sessions: lead (app-lead), alpha (app-alpha), bravo (app-bravo))'],
    );
  });

  it('reminds the Claude Code session that last read an inbox of new lines', async () => {
    const kit = new CliHarness();
    const stdin = JSON.stringify({ session_id: CLAUDE_SESSION });
    await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin })).stdout, []);

    await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'please rebase', '--session', 'alpha']);
    const reminded = await kit.run(['hook', 'inbox-reminder'], { stdin });
    assert.equal(reminded.code, EXIT.ok);
    assert.match(reminded.stdout[0] ?? '', /^INBOX: 1 unread line\(s\) .* teamrig inbox read --session bravo$/);
  });

  it('reminds a session named by $TEAMRIG_SESSION before it has ever read its inbox', async () => {
    const kit = new CliHarness();
    const stdin = JSON.stringify({ session_id: CLAUDE_SESSION });
    await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'please rebase', '--session', 'alpha']);
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin })).stdout, [], 'unnamed and never read: no session to remind');

    const reminded = await kit.run(['hook', 'inbox-reminder'], { stdin, env: { TEAMRIG_SESSION: 'app-bravo' } });
    assert.match(reminded.stdout[0] ?? '', /^INBOX: 1 unread line\(s\) .* teamrig inbox read --session bravo$/, 'found by its name');
    const unknown = await kit.run(['hook', 'inbox-reminder'], { stdin, env: { TEAMRIG_SESSION: 'zulu' } });
    assert.deepEqual(unknown.stdout, []);
  });

  it('keeps the reminder hook silent on bad input or without a config', async () => {
    assert.deepEqual(await new CliHarness().run(['hook', 'inbox-reminder'], { stdin: 'not json' }), { code: EXIT.ok, stdout: [], stderr: [] });
    const noConfig = await new CliHarness(null).run(['hook', 'inbox-reminder'], { stdin: JSON.stringify({ session_id: CLAUDE_SESSION }) });
    assert.deepEqual(noConfig, { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('runCli: hook push-guard', () => {
  it('asks before a push to a protected branch and refuses a force-push of one', async () => {
    const kit = new CliHarness();
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main') })), 'ask');
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push --force origin main') })), 'deny');
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin dev') })), undefined);
  });

  it('takes the protected branches from the team config', async () => {
    const kit = new CliHarness({ ...TEAM, pushGuard: { protectedBranches: ['release'] } });
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main') })), undefined);
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin release') })), 'ask');
  });

  it('keeps the default branches when the config is missing or unreadable', async () => {
    for (const kit of [new CliHarness(null), new CliHarness('{ not json')]) {
      const result = await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main') });
      assert.equal(result.code, EXIT.ok);
      assert.equal(decisionOf(result), 'ask');
    }
  });

  it('allows silently on input that is not a hook payload', async () => {
    assert.deepEqual(await new CliHarness().run(['hook', 'push-guard'], { stdin: 'not json' }), { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('runCli: hook session-start', () => {
  it("loads the core rules, the session's identity and the team's rules", async () => {
    const kit = new CliHarness({ ...TEAM, names: { lead: 'team-lead' } });
    await kit.files.write(join(KIT, 'teams', 'app', 'rules.md'), 'Ship small.');
    const result = await kit.run(['hook', 'session-start'], { env: { TEAMRIG_SESSION: 'app-alpha' }, stdin: JSON.stringify({ cwd: APP }) });
    assert.equal(result.code, EXIT.ok);
    const text = contextOf(result);
    assert.match(text, /^# Team rules \(teamrig core\)/);
    assert.ok(text.includes('You are the `alpha` session of team `app` (name `app-alpha`). Message the lead as `team-lead`.'));
    assert.ok(text.endsWith("# Your team's rules\nShip small."));
  });

  it('says why no rules load without a team config', async () => {
    const text = contextOf(await new CliHarness(null).run(['hook', 'session-start']));
    assert.equal(text, `teamrig is enabled here but team app has no config at ${CONFIG_PATH}, so no team rules are loaded. Create it with: teamrig team create app --sessions <id,id>`);
  });

  it('turns a broken pointer into one line of context', async () => {
    const text = contextOf(await new CliHarness(TEAM, '{"team": 7}').run(['hook', 'session-start']));
    assert.equal(text, `teamrig: no team, so no team rules: ${POINTER} has no "team" text; expected {"team": "<id>"}`);
  });
});

describe('runCli: which team', () => {
  const VALID = { code: EXIT.ok, stdout: [`VALID ${CONFIG_PATH}`], stderr: [] };
  const SILENT = { code: EXIT.ok, stdout: [], stderr: [] };
  const ELSEWHERE = resolve('/', 'elsewhere');

  it('finds the team from the nearest pointer above the working folder', async () => {
    assert.deepEqual(await new CliHarness().run(['config', 'validate'], { cwd: join(APP, 'src', 'core') }), VALID);
  });

  it("falls back to the session's project folder", async () => {
    const result = await new CliHarness().run(['config', 'validate'], { cwd: ELSEWHERE, env: { CLAUDE_PROJECT_DIR: APP } });
    assert.deepEqual(result, VALID);
  });

  it('takes $TEAMRIG_TEAM over the pointer', async () => {
    const result = await new CliHarness().run(['config', 'validate'], { env: { TEAMRIG_TEAM: 'ops' } });
    assert.equal(result.code, EXIT.refused);
    assert.equal(result.stdout[0], `REFUSED no team config at ${join(KIT, 'teams', 'ops', 'config.json')}`);
  });

  it('refuses a command with no team, naming both ways to set one', async () => {
    const result = await new CliHarness(TEAM, null).run(['list', '--session', 'alpha']);
    assert.deepEqual(
      [result.code, result.stdout],
      [
        EXIT.refused,
        [
          'REFUSED no team here: create one with teamrig team create <team> --sessions <id,id>, set $TEAMRIG_TEAM, or put .teamrig.json {"team": "<id>"} in the project folder',
        ],
      ],
    );
  });

  it('refuses a command on a broken pointer, naming the file to fix', async () => {
    const result = await new CliHarness(TEAM, 'team: app').run(['list', '--session', 'alpha']);
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, [`REFUSED ${POINTER} is not JSON; expected {"team": "<id>"}`]]);
  });

  it('keeps every hook silent outside every team project', async () => {
    const kit = new CliHarness(TEAM, null);
    assert.deepEqual(await kit.run(['hook', 'push-guard'], { stdin: bash('git push --force origin main') }), SILENT);
    assert.deepEqual(await kit.run(['hook', 'inbox-reminder'], { stdin: JSON.stringify({ session_id: CLAUDE_SESSION }) }), SILENT);
    assert.deepEqual(await kit.run(['hook', 'session-start'], { stdin: JSON.stringify({ cwd: APP }) }), SILENT);
  });

  it("finds a hook's team from the payload's folder, not where the hook process started", async () => {
    const kit = new CliHarness({ ...TEAM, pushGuard: { protectedBranches: ['release'] } });
    const result = await kit.run(['hook', 'push-guard'], { cwd: ELSEWHERE, stdin: bash('git push origin release') });
    assert.equal(decisionOf(result), 'ask');
  });

  it('still guards the default branches on a broken pointer', async () => {
    const kit = new CliHarness(TEAM, '{"team": "../app"}');
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main') })), 'ask');
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push --force origin main') })), 'deny');
  });

  it('turns a broken pointer into one line of context instead of a silent inbox', async () => {
    const result = await new CliHarness(TEAM, '{"team": 7}').run(['hook', 'inbox-reminder'], { stdin: JSON.stringify({ session_id: CLAUDE_SESSION }) });
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [`teamrig: no team, so no inbox reminder: ${POINTER} has no "team" text; expected {"team": "<id>"}`],
      stderr: [],
    });
  });
});

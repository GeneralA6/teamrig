import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { CONFIG_MIGRATIONS, type ConfigFormat } from '../config/migrate.ts';
import { CONFIG_VERSION } from '../config/types.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { FakePackageRegistry } from '../testing/fake-package-registry.ts';
import { KEPT_PUSH_RULE, keptPushLineOf, teamHomeOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { ENV } from '../core/home.ts';
import { CLIENT_MANIFEST, clientFileHash, clientManifestText, clientRootOf } from '../exec/client-integrity.ts';
import { quietWorld } from '../testing/quiet-world.ts';
import { configChangedMeanwhile, hired } from '../testing/config-race.ts';
import { KIT_VERSION } from '../core/version.ts';
import { ASK_REFUSED_NOTE } from '../hooks/permission.ts';
import { APP, bash, CLAUDE_SESSION, CliHarness, CONFIG_PATH, contextOf, decisionOf, EVENTS_PATH, KIT, POINTER, reasonOf, SKILLS_DIR, TEAM, type CliResult } from '../testing/cli-harness.ts';
import { cutLineMessage } from './cmd-shim.ts';
import { FULL_HELP_POINTER } from './help.ts';
import { SHORT_FORM_CHARS } from './reports.ts';
import { COMMAND_HELP, USAGE } from './run.ts';
import { EXIT } from './runtime.ts';

/** A release one config version ahead of this one, reached by a last step that changes only the version. */
const NEXT_FORMAT: ConfigFormat = {
  version: CONFIG_VERSION + 1,
  migrations: [...CONFIG_MIGRATIONS, { from: CONFIG_VERSION, firstRelease: '9.0.0', apply: (config) => ({ config, changes: ['added a flag'] }) }],
};
/** The team roster in this release's config format, so nothing is pending a migration. */
const CURRENT_TEAM: JsonRecord = { ...TEAM, configVersion: CONFIG_VERSION };

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

  it('writes every environment variable it names as $NAME, as the rest of teamrig does', async () => {
    const help = (await new CliHarness().run(['--help'])).stdout.join('\n');
    for (const name of [ENV.home, ENV.team, ENV.session, 'CLAUDE_PROJECT_DIR']) assert.ok(help.includes(`$${name}`), `the help names $${name}`);
    for (const name of [...Object.values(ENV), 'CLAUDE_PROJECT_DIR']) {
      assert.doesNotMatch(help, new RegExp(`(^|[^$])\\b${name}\\b`), `every ${name} in the help has its $`);
    }
  });

  it('prints the version', async () => {
    assert.deepEqual((await new CliHarness().run(['--version'])).stdout, [`teamrig ${KIT_VERSION}`]);
  });

  it("exits 64 with the reason and only the command's usage on a line it cannot read", async () => {
    const kit = new CliHarness();
    const result = await kit.run(['add', '--titel', 'x', '--session', 'alpha']);
    assert.equal(result.code, EXIT.usage);
    assert.deepEqual(result.stderr, [`add takes no --titel\n\n${COMMAND_HELP.forCommand('add')}`]);
    assert.match(result.stderr.join('\n'), /^add takes no --titel\n\nteamrig <command>.*\n {2}add --title /);

    const done = await kit.run(['set', 'T1', 'done', '--session', 'alpha']);
    const head = USAGE.split('\n')[0] ?? '';
    const setLines = [
      '  set <id> --status open|in-progress|verifying|waiting|done|dropped [--note "<what/why>"] [--evidence <proof>]',
      '      [--skill <name>|none] [--followups T<id>,...|none] [--waits decision:<who>,approval:<who>,task:T<id>,time:<date>]',
      '      [--question ".." --options "<a> | <b>" --recommend ".." --default ".." --why-ask ".." --gate ".."]',
      '      [--proof "<what proves it>"] [--watch "<what a sighting shows>"] [--met "<what shows it>"] [--due <date>]',
      '      [--ask <session> --text "<the work>"]',
      '      [--cause ".." --how ".." --prevent ".." --harden ".." --missed-test ".." --missed-monitor ".." --missed-log ".."]',
      '      verifying needs --proof: what will prove the shipped change works; --due sets the date to verify by',
      '      --watch (with done only, and evidence given or kept): a change tests or a dry run proved, whose live',
      '      proof is a sighting to come; verify lists it until you set it done again without --watch, or reopen it',
      "      a start that a verifying task it needs holds goes through with --met: what shows that task's proof",
      '      exists; its owner gets an inbox line to set it done or reopen it',
      '      verifying and done need --followups: the tasks the work leaves (a finding, a next step), or none',
      '      (register.requireFollowupsOn); show lists them',
      "      waiting needs --waits: the lead's or the owner's decision or approval, a task to finish first",
      '      (only once started) or a time; check flags it READY once its tasks finished and its time passed',
      "      --ask (with waiting only): adds the work as that session's task and waits on it; --due is then the",
      "      asked task's due date",
      '      verifying needs --waits for when its proof runs: a time, or a task in progress or verifying (the',
      "      owner's approval may stand beside one); set verifying again without --waits keeps them",
      "      a wait on the owner's decision or approval needs a card the owner decides from alone",
      '      (register.requireDecisionCard): --question "<what is decided>" --options "<a, its numbers> | <b>"',
      '      --recommend "<which, and why>" --default "<what happens with no answer>"; each part at least 3 words',
      '      besides task ids; a later set changes one part alone',
      '      a task the owner ordered asks the owner only with --why-ask "<how the order must change, what new it',
      '      needs, or why only the owner can see the result>"; check flags it OWNER-ORDERED without one',
      "      a wait on the owner's decision names what makes it the owner's: --gate \"<an owner gate (ownerGates)",
      "      or business>\"; any other question is yours or your leader's: decide it, or wait on your leader;",
      '      check flags it UNGATED without one',
      '      a bug gives its review (register.review): --cause "<the root cause, at its source>"',
      '      --how "<the change or assumption that let it in>" --prevent "<what stops it coming back>", and',
      '      --missed-test, --missed-monitor and --missed-log "<a follow-up task that adds it, or why none can catch it>";',
      '      a critical one (--critical, or an owner in criticalOwners) --harden "<past the direct guard>" too;',
      '      each part at least 3 words besides task ids, kept across sets; tasks a missed part names join',
      '      --followups; verifying and done need every part (requireOn; mode refuse, warn or off)',
    ];
    assert.deepEqual([done.code, done.stderr], [EXIT.usage, [['unexpected "done"', '', head, ...setLines, FULL_HELP_POINTER].join('\n')]]);
    assert.equal((done.stderr[0] ?? '').length < USAGE.length / 5, true, 'a fifth of the full help at most');

    const status = await kit.run(['set', 'T1', '--status', 'in_progress', '--session', 'alpha']);
    assert.match(status.stderr[0] ?? '', /^--status "in_progress" is not open\|.*\n\nteamrig <command>.*\n {2}set <id> --status /);

    const group = await kit.run(['inbox']);
    assert.deepEqual([group.code, group.stderr], [EXIT.usage, [`inbox read|status|add\n\n${COMMAND_HELP.forCommand('inbox')}`]]);
    const unknown = await kit.run(['frob']);
    assert.match(unknown.stderr[0] ?? '', /^unknown command "frob"\n\nteamrig <command>.*\nCommands: add, set, update, refs, approve, list, show, check, plan, verify, stats, report, goal, files, inbox, exec, team, /);
  });

  it("prints one command's help for <command> --help or -h, or a group's, and exits 0", async () => {
    const kit = new CliHarness();
    const add = await kit.run(['add', '--help']);
    assert.deepEqual([add.code, add.stdout, add.stderr], [EXIT.ok, [COMMAND_HELP.forCommand('add')], []]);
    assert.match(add.stdout[0] ?? '', /\n {2}add --title .*\n(?: {6}\[.*\n)+ {6}--description: .*\n {6}\S.*\n {6}--after: .*\n {6}--size: .*\n {6}\S.*\n {6}--type: .*\n(?: {6}\S.*\n)+ {2}add --team /);
    assert.match(add.stdout[0] ?? '', / \[--goals a,b\|none\]\n/, "add's usage names --goals none, which add takes (T1730)");
    assert.deepEqual((await kit.run(['set', 'T1', '-h'])).stdout, [COMMAND_HELP.forCommand('set')]);
    const inbox = await kit.run(['inbox', '--help']);
    assert.deepEqual(
      (inbox.stdout[0] ?? '')
        .split('\n')
        .filter((line) => /^ {2}\S/.test(line))
        .map((line) => line.trim().split(' ').slice(0, 2).join(' ')),
      ['inbox read', 'inbox status', 'inbox add'],
    );
    assert.equal(kit.files.get(EVENTS_PATH), undefined);
  });

  it('gives every command its own lines in the help, and states the short form limit there', () => {
    assert.deepEqual(COMMAND_HELP.undocumented(), []);
    assert.ok(USAGE.includes(`within ${SHORT_FORM_CHARS.toLocaleString('en-US')} characters`));
    assert.match(USAGE, /\nOne command's help: teamrig <command> --help\.$/);
  });

  it('refuses the renamed --tier on any command and a priority in the old spelling, writing nothing', async () => {
    const kit = new CliHarness();
    /** A usage error prints its reason, then the usage. */
    const reasonOf = (result: CliResult): string | undefined => result.stderr[0]?.split('\n')[0];
    for (const argv of [
      ['add', '--title', 'x', '--description', 'what and why', '--tier', '2', '--session', 'alpha'],
      ['list', '--tier', '1,2', '--session', 'alpha'],
      ['show', 'T1', '--tier', '2', '--session', 'alpha'],
    ]) {
      const result = await kit.run(argv);
      assert.equal(result.code, EXIT.usage, argv.join(' '));
      assert.equal(reasonOf(result), '--tier was renamed: use --priority', argv.join(' '));
    }
    const oldSpelling = await kit.run(['add', '--title', 'x', '--description', 'what and why', '--priority', 't2', '--session', 'alpha']);
    assert.deepEqual([oldSpelling.code, reasonOf(oldSpelling)], [EXIT.usage, 'priority "t2" is the old tier spelling: write p2']);
    const bare = await kit.run(['update', 'T1', '--priority', '3', '--session', 'alpha']);
    assert.deepEqual([bare.code, reasonOf(bare)], [EXIT.usage, 'priority "3" is not p<n>: write p3']);
    assert.equal(kit.files.get(EVENTS_PATH), undefined);
  });
});

describe('runCli: a command line cmd.exe cut at a line break', () => {
  /** The line PowerShell 5.1 hands cmd.exe for the shim, of which cmd passed the CLI only the first line. */
  const ADD_LINE = 'C:\\WINDOWS\\system32\\cmd.exe /c ""C:\\kit\\bin\\teamrig.cmd" add --title "Ship it" --description "line one\nline two\nline three" --priority p2 --session alpha"';

  it('runs the arguments rebuilt from the line, every line and the flags after it kept', async () => {
    const kit = new CliHarness();
    const added = await kit.run(['add', '--title', 'Ship it', '--description', 'line one'], { cmdShimLine: ADD_LINE });
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    assert.match(added.stdout[0] ?? '', /^ADDED T1 open, p2, owner alpha,/);
    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.match(shown.stdout.join('\n'), /description: line one\n {2}line two\n {2}line three\n/);
  });

  it('refuses a cut line it cannot read back, with the ways to run it whole, and runs nothing', async () => {
    const kit = new CliHarness();
    const result = await kit.run(['version'], { cmdShimLine: ADD_LINE });
    assert.deepEqual([result.code, result.stdout, result.stderr], [EXIT.usage, [], [cutLineMessage('/opt/teamrig/dist/cli/main.js')]]);
    assert.equal(kit.files.get(EVENTS_PATH), undefined);
  });
});

describe('runCli: the task register', () => {
  it('adds, lists, sets and shows a task', async () => {
    const kit = new CliHarness();
    const added = await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    assert.match(added.stdout[0] ?? '', /^ADDED T1 open, p2, owner alpha, from \S+ \| /);

    const listed = await kit.run(['list'], { env: { TEAMRIG_SESSION: 'alpha' } });
    assert.deepEqual([listed.code, listed.stdout], [EXIT.ok, ['LIST 1 task(s) (short rows; --all for every field)', 'T1 open, p2, owner alpha | Ship the CLI']]);
    const full = await kit.run(['list', '--all'], { env: { TEAMRIG_SESSION: 'alpha' } });
    assert.match(full.stdout.join('\n'), /^T1 open, p2, owner alpha, from \S+ \| Ship the CLI$/);

    const set = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
    assert.match(set.stdout[0] ?? '', /^SET T1 in-progress, p2, owner alpha,/);

    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.equal(shown.code, EXIT.ok);
    assert.match(shown.stdout.join('\n'), /Ship the CLI/);
  });

  it('exits 2 with REFUSED when a team rule refuses a write', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    const notOwner = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'bravo']);
    assert.equal(notOwner.code, EXIT.refused);
    assert.deepEqual(notOwner.stdout, ['REFUSED only the owner (alpha) sets the status of T1']);

    const noSkill = await kit.run(['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc123', '--session', 'alpha']);
    assert.equal(noSkill.code, EXIT.refused);
    assert.match(noSkill.stdout[0] ?? '', /^REFUSED done needs --skill/);

    const done = await kit.run(['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc123', '--skill', 'none', '--followups', 'none', '--session', 'alpha']);
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

    const added = await kit.run(['add', '--title', 'x', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    assert.equal(added.code, EXIT.refused);
    assert.match(added.stdout[0] ?? '', /^REFUSED the team config has 1 problem\(s\)/);
  });

  it('reads a config from a newer teamrig best-effort but never writes through it', async () => {
    const kit = new CliHarness({ ...TEAM, configVersion: 99 });
    const listed = await kit.run(['list', '--session', 'alpha']);
    assert.equal(listed.code, EXIT.ok);
    assert.match(listed.stderr[0] ?? '', /config version 99, from a newer teamrig/);
    assert.equal((await kit.run(['add', '--title', 'x', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha'])).code, EXIT.refused);
  });

  it('updates a task, reading the new owner as a session', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    const updated = await kit.run(['update', 'T1', '--owner', 'bravo', '--note', 'bravo takes it', '--session', 'alpha']);
    assert.equal(updated.code, EXIT.ok, updated.stdout.join('\n'));
    assert.match(updated.stdout[0] ?? '', /^UPDATED T1 open, p2, owner bravo,/);
    const retitled = await kit.run(['update', 'T1', '--title', 'Ship the CLI twice', '--session', 'bravo']);
    assert.equal(retitled.code, EXIT.ok, retitled.stdout.join('\n'));
    assert.match(retitled.stdout[0] ?? '', /Ship the CLI twice/);
  });

  it('needs a description to add a task, shows it under the title, and keeps it on an update', async () => {
    const kit = new CliHarness();
    const bare = await kit.run(['add', '--title', 'Ship the CLI', '--priority', 'p2', '--session', 'alpha']);
    assert.deepEqual([bare.code, bare.stdout], [EXIT.refused, ['REFUSED add needs --description "<what and why, in plain words>"']]);
    assert.equal(kit.files.get(EVENTS_PATH), undefined);
    const added = await kit.run(['add', '--title', 'Ship the CLI', '--description', 'Users wait on it.\nShip it with docs.', '--ref', 'inbox:3', '--priority', 'p2', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.deepEqual(shown.stdout.join('\n').split('\n').slice(1, 4), ['description: Users wait on it.', '  Ship it with docs.', 'ref: inbox:3']);
    const cleared = await kit.run(['update', 'T1', '--description', 'none', '--session', 'alpha']);
    assert.deepEqual([cleared.code, cleared.stdout], [EXIT.refused, ['REFUSED T1 keeps a description while register.requireDescription is on: give a new one instead of none']]);
    const changed = await kit.run(['update', 'T1', '--description', 'Users wait on it.', '--session', 'alpha']);
    assert.equal(changed.code, EXIT.ok, changed.stdout.join('\n'));
    const history = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.match(history.stdout.join('\n').split('\n').at(-1) ?? '', / alpha update description="Users wait on it\."$/);
  });

  it('adds a task with no description when the team turns the demand off, and clears one', async () => {
    const kit = new CliHarness({ ...TEAM, register: { requireDescription: false } });
    const added = await kit.run(['add', '--title', 'Ship the CLI', '--description', 'Why.', '--priority', 'p2', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    const cleared = await kit.run(['update', 'T1', '--description', 'none', '--session', 'alpha']);
    assert.equal(cleared.code, EXIT.ok, cleared.stdout.join('\n'));
    assert.ok(!(await kit.run(['show', 'T1', '--session', 'alpha'])).stdout.join('\n').includes('description:'));
    assert.equal((await kit.run(['add', '--title', 'Plan the week', '--priority', 'p2', '--session', 'alpha'])).code, EXIT.ok);
  });

  it('refuses to show a task it does not hold', async () => {
    const result = await new CliHarness().run(['show', 'T9', '--session', 'alpha']);
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, ['REFUSED no task T9']]);
  });

  it('names damaged lines on stderr and still reads the rest', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    await kit.files.append(EVENTS_PATH, '{ torn\n');
    const listed = await kit.run(['list', '--session', 'alpha']);
    assert.equal(listed.code, EXIT.ok);
    assert.match(listed.stdout.join('\n'), /^T1 open, p2, owner alpha \| Ship the CLI$/m);
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
    await kit.holdSecretDeny();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--due', '2030-01-10', '--session', 'alpha']);
    // Owned by a session on the team, so its flag stays under SKILLS; an ownerless skill's go to the lead (context-check.test.ts).
    await kit.files.write(join(SKILLS_DIR, 'alpha-demo', 'SKILL.md'), '---\nname: alpha-demo\ndescription: A demo skill never verified.\n---\nOwner: alpha\n');

    const bare = await kit.run(['check', '--session', 'alpha', '--all']);
    assert.equal(bare.code, EXIT.ok);
    assert.equal(bare.stdout[0], 'CHECK 0 flag(s), no week plan tagged yet, so the week checks are skipped');

    const weekly = await kit.run(['check', '--week', '2030-01-07', '--session', 'alpha', '--all']);
    assert.equal(weekly.code, EXIT.ok);
    assert.equal(weekly.stdout[0], 'CHECK 1 flag(s), week 2030-01-07');
    assert.match(weekly.stdout[1] ?? '', /^DUE-UNPLANNED \(due inside week 2030-01-07, not in its plan\) T1 open, p2, owner alpha, due 01-10, from alpha \| Ship the CLI$/);
    const skills = weekly.stdout.findIndex((line) => line.startsWith('SKILLS '));
    assert.match(weekly.stdout[skills] ?? '', /^SKILLS [1-9]\d* flag\(s\) in /);
    assert.match(weekly.stdout[skills + 1] ?? '', /^SKILL \S+ \(.*\) alpha alpha-demo$/);

    const short = await kit.run(['check', '--week', '2030-01-07', '--session', 'alpha']);
    assert.equal(short.code, EXIT.ok);
    assert.deepEqual(short.stdout.slice(0, 3), [
      'CHECK 1 flag(s), week 2030-01-07 (short form; --all for every flag in full)',
      'DUE-UNPLANNED 1 (due inside week 2030-01-07, not in its plan)',
      '  T1 open, p2, owner alpha, due 01-10 | Ship the CLI',
    ]);
    assert.match(short.stdout[3] ?? '', /^SKILLS [1-9]\d* flag\(s\) in /);
    assert.match(short.stdout[4] ?? '', /^ {2}SKILL \S+ \(.*\) alpha alpha-demo$/);
    const empty = new CliHarness();
    await empty.holdSecretDeny();
    const nothing = await empty.run(['check', '--session', 'alpha']);
    assert.deepEqual(nothing.stdout[0], 'CHECK 0 flag(s), no week plan tagged yet, so the week checks are skipped');
  });

  it('plans the newest started week, or the one given, and refuses before any plan', async () => {
    const kit = new CliHarness();
    const none = await kit.run(['plan', '--session', 'alpha']);
    assert.deepEqual([none.code, none.stdout], [EXIT.refused, ['REFUSED no week plan tagged yet; pass --week <YYYY-MM-DD>']]);

    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--week', '2030-01-07', '--session', 'alpha']);
    const current = await kit.run(['plan', '--session', 'alpha']);
    assert.equal(current.code, EXIT.ok);
    assert.match(current.stdout.join('\n'), /2030-01-07[\s\S]*Ship the CLI/);
    const given = await kit.run(['plan', '--week', '2030-01-07', '--session', 'alpha']);
    assert.deepEqual(given.stdout, current.stdout);
  });
});

describe('runCli: config', () => {
  it('validates a good config', async () => {
    const result = await new CliHarness(CURRENT_TEAM).run(['config', 'validate']);
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, [`VALID ${CONFIG_PATH}`]]);
  });

  it('lists every problem and exits 1', async () => {
    const result = await new CliHarness({ ...CURRENT_TEAM, pushGuard: { protectedBranches: 'main' } }).run(['config', 'validate']);
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
    const current = await new CliHarness(CURRENT_TEAM).run(['config', 'migrate']);
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

  it('notes an older config, shows its rewrite and the release it needs, then writes it with --yes and keeps the old file', async () => {
    const [current, next] = [CONFIG_VERSION, CONFIG_VERSION + 1];
    const kit = new CliHarness(CURRENT_TEAM);
    const validated = await kit.run(['config', 'validate'], { configFormat: NEXT_FORMAT });
    assert.equal(validated.code, EXIT.ok);
    assert.deepEqual(validated.stdout, [`NOTE config version ${current} is older than ${next}, read as ${next} in memory; teamrig config migrate shows the rewrite`, `VALID ${CONFIG_PATH}`]);

    const before = kit.files.get(CONFIG_PATH);
    const preview = await kit.run(['config', 'migrate'], { configFormat: NEXT_FORMAT });
    assert.deepEqual(
      [preview.code, preview.stdout],
      [
        EXIT.ok,
        [
          `PREVIEW ${CONFIG_PATH} from version ${current} to ${next}; nothing written`,
          `  v${current}→v${next}: added a flag`,
          `NOTE every command reads it as version ${next} already; once written, a tab on a teamrig before 9.0.0 refuses every write until it restarts. Restart those tabs, then: teamrig config migrate --yes`,
        ],
      ],
    );
    assert.equal(kit.files.get(CONFIG_PATH), before);

    const migrated = await kit.run(['config', 'migrate', '--yes'], { configFormat: NEXT_FORMAT });
    assert.equal(migrated.code, EXIT.ok, migrated.stdout.join('\n'));
    assert.match(migrated.stdout[0] ?? '', new RegExp(`^MIGRATED .* from version ${current} to ${next}; the old file is at .*config\\.v${current}\\.json$`));
    assert.deepEqual(migrated.stdout.slice(1), [`  v${current}→v${next}: added a flag`]);
    assert.match(kit.files.get(CONFIG_PATH) ?? '', new RegExp(`"configVersion": ${next}`));

    const again = await kit.run(['config', 'migrate', '--yes'], { configFormat: NEXT_FORMAT });
    assert.deepEqual(again.stdout, [`UNCHANGED ${CONFIG_PATH} needs no migration`]);
  });

  it('migrates the config as it reads under the config lock, keeping a session hired meanwhile', async () => {
    const kit = new CliHarness(CURRENT_TEAM);
    const sleep = await configChangedMeanwhile(kit, hired('dave'));
    const migrated = await kit.run(['config', 'migrate', '--yes'], { configFormat: NEXT_FORMAT, sleep });
    assert.equal(migrated.code, EXIT.ok, migrated.stdout.join('\n'));
    const text = kit.files.get(CONFIG_PATH);
    const config: unknown = text === undefined ? undefined : JSON.parse(text);
    assert.ok(isRecord(config), text);
    assert.deepEqual([config['sessions'], config['configVersion']], [['lead', 'alpha', 'bravo', 'dave'], CONFIG_VERSION + 1]);
  });

  it('migrates a version-1 config: its register.tiers become register.priorities', async () => {
    const priorities = [{ id: 1, name: 'now' }, { id: 2, name: 'later' }];
    const kit = new CliHarness({ ...TEAM, configVersion: 1, register: { tiers: priorities } });
    const validated = await kit.run(['config', 'validate']);
    assert.deepEqual(
      [validated.code, validated.stdout],
      [EXIT.ok, [`NOTE config version 1 is older than ${CONFIG_VERSION}, read as ${CONFIG_VERSION} in memory; teamrig config migrate shows the rewrite`, `VALID ${CONFIG_PATH}`]],
    );

    const migrated = await kit.run(['config', 'migrate', '--yes']);
    assert.equal(migrated.code, EXIT.ok, migrated.stdout.join('\n'));
    assert.deepEqual(migrated.stdout.slice(1), ['  v1→v2: register.tiers → register.priorities']);
    const written: unknown = JSON.parse(kit.files.get(CONFIG_PATH) ?? '');
    assert.deepEqual(written, { ...TEAM, configVersion: CONFIG_VERSION, register: { priorities } });
  });

  it('migrates a version-2 config: register.requireNoteOn names waiting where it named blocked', async () => {
    const kit = new CliHarness({ ...TEAM, configVersion: 2, register: { requireNoteOn: ['blocked', 'done'] } });
    const migrated = await kit.run(['config', 'migrate', '--yes']);
    assert.equal(migrated.code, EXIT.ok, migrated.stdout.join('\n'));
    assert.deepEqual(migrated.stdout.slice(1), ['  v2→v3: register.requireNoteOn: blocked → waiting']);
    const written: unknown = JSON.parse(kit.files.get(CONFIG_PATH) ?? '');
    assert.deepEqual(written, { ...TEAM, configVersion: CONFIG_VERSION, register: { requireNoteOn: ['waiting', 'done'] } });
  });

  it('names blocked in a current config as replaced by waiting', async () => {
    const result = await new CliHarness({ ...CURRENT_TEAM, register: { requireNoteOn: ['blocked'] } }).run(['config', 'validate']);
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stdout.join('\n'), /register\.requireNoteOn\[0\]: expected one of .*, got "blocked" \(blocked was replaced by waiting\)/);
  });

  it('names register.tiers in a current config as renamed', async () => {
    const result = await new CliHarness({ ...CURRENT_TEAM, register: { tiers: [{ id: 1, name: 'now' }] } }).run(['config', 'validate']);
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout.slice(1), ['  register.tiers: was renamed: use register.priorities']);
  });
});

describe('runCli: session names', () => {
  const NAMED: JsonRecord = { ...TEAM, names: { lead: 'captain' }, roles: { lead: 'lead', deliveryOwner: 'alpha' } };

  it('takes a name wherever it takes a session, and keys everything by id', async () => {
    const kit = new CliHarness(NAMED);
    const posted = await kit.run(['inbox', 'add', '--to', 'captain', '--text', 'ready', '--session', 'app-alpha']);
    assert.match(posted.stdout[0] ?? '', /^POSTED to lead; lead is reminded at its next prompt$/);
    const read = await kit.run(['inbox', 'read', '--session', 'captain']);
    assert.deepEqual(read.stdout[0], '- 2030-01-08 10:00 UTC alpha: ready');

    const added = await kit.run(['add', '--title', 'Ship the names', '--description', 'what and why', '--priority', 'p2', '--owner', 'app-bravo', '--session', 'captain']);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    const byName = await kit.run(['list', '--session', 'app-bravo', '--all']);
    assert.deepEqual(byName.stdout, (await kit.run(['list', '--session', 'bravo', '--all'])).stdout);
    assert.equal(byName.stdout.length, 1);
    const set = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'app-bravo']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
  });

  it('refuses a name the team does not use', async () => {
    const result = await new CliHarness(NAMED).run(['inbox', 'add', '--to', 'app-lead', '--text', 'hi', '--session', 'alpha']);
    assert.deepEqual(
      [result.code, result.stdout[0]],
      [EXIT.refused, 'REFUSED app-lead is not a session on this team (sessions: lead (captain), alpha (app-alpha), bravo (app-bravo))'],
    );
  });

  it('still filters by the id of a session no longer on the team, but not by an unknown name', async () => {
    const kit = new CliHarness(NAMED);
    assert.deepEqual(await kit.run(['list', '--session', 'zulu']), { code: EXIT.ok, stdout: ['LIST 0 task(s)'], stderr: [] });
    assert.deepEqual(await kit.run(['list', '--session', 'zulu', '--all']), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.match((await kit.run(['inbox', 'status', '--session', 'zulu'])).stdout[0] ?? '', /^INBOX no inbox for zulu in /);
    const long = await kit.run(['list', '--session', 'app-a-name-longer-than-any-session-id']);
    assert.equal(long.code, EXIT.refused);
  });

  it('prints who to message, by id, name or role, or the whole roster', async () => {
    const kit = new CliHarness(NAMED);
    const names = await Promise.all(['lead', 'captain', 'deliveryOwner', 'bravo'].map((text) => kit.run(['who', text])));
    assert.deepEqual(
      names.map((result) => result.stdout),
      [['captain'], ['captain'], ['app-alpha'], ['app-bravo']],
    );
    assert.deepEqual((await kit.run(['who'])).stdout, ['lead captain (lead)', 'alpha app-alpha (deliveryOwner)', 'bravo app-bravo']);
  });

  it('refuses who for a role nobody holds or a stranger', async () => {
    const kit = new CliHarness();
    const role = await kit.run(['who', 'deliveryOwner']);
    assert.deepEqual([role.code, role.stdout[0]], [EXIT.refused, 'REFUSED no session holds the deliveryOwner role']);
    assert.equal((await kit.run(['who', 'zulu'])).code, EXIT.refused);
    assert.equal((await kit.run(['who', 'a', 'b'])).code, EXIT.usage);
  });
});

describe('runCli: inboxes', () => {
  it("shows the lines and when they wait since on the team's clock", async () => {
    const kit = new CliHarness();
    const inIsrael = { timeZone: 'Asia/Jerusalem' };
    await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'the build is green', '--session', 'alpha']);
    assert.match((await kit.run(['inbox', 'status'], inIsrael)).stdout.join('\n'), /^bravo 1 unread since 01-08 12:00 IST /m);
    const read = await kit.run(['inbox', 'read', '--session', 'bravo'], inIsrael);
    assert.deepEqual(read.stdout.slice(0, 1), ['- 2030-01-08 12:00 IST alpha: the build is green']);
    assert.equal(kit.files.get(teamInboxOf('app', 'bravo')),'- 2030-01-08 10:00 alpha: the build is green\n', 'the file keeps UTC');
  });

  it('posts a line, reads it once, then has nothing new', async () => {
    const kit = new CliHarness();
    const posted = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'the build is green', '--session', 'alpha']);
    assert.equal(posted.code, EXIT.ok, posted.stdout.join('\n'));
    assert.match(posted.stdout[0] ?? '', /^POSTED to bravo; bravo is reminded at its next prompt$/);

    const status = await kit.run(['inbox', 'status']);
    assert.match(status.stdout.join('\n'), /bravo/);

    const first = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.equal(first.code, EXIT.ok);
    assert.deepEqual(first.stdout.slice(0, 1), ['- 2030-01-08 10:00 UTC alpha: the build is green']);
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

  it('shows the Claude Code session that last read an inbox its new lines, once', async () => {
    const kit = new CliHarness();
    // Titled as the prompt hook titles a bound tab (T407), so the lines come as plain text.
    const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, session_title: 'app-bravo' });
    await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin })).stdout, []);

    await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'please rebase', '--session', 'alpha']);
    const reminded = await kit.run(['hook', 'inbox-reminder'], { stdin });
    assert.equal(reminded.code, EXIT.ok);
    assert.match(reminded.stdout[0] ?? '', /^INBOX bravo, new in .*bravo\.md \(each line is shown once; reading marks them read\):\n- 2030-01-08 10:00 UTC alpha: please rebase$/);
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin })).stdout, [], 'shown once');
    assert.match((await kit.run(['inbox', 'status', '--session', 'bravo'])).stdout[0] ?? '', /^bravo 1 unread/, 'shown is not read');
  });

  it('shows a session named by $TEAMRIG_SESSION its lines before it has ever read its inbox', async () => {
    const kit = new CliHarness();
    const stdin = JSON.stringify({ session_id: CLAUDE_SESSION });
    await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'please rebase', '--session', 'alpha']);
    const unbound = await kit.run(['hook', 'inbox-reminder'], { stdin });
    assert.deepEqual(unbound.stdout.map((line) => line.slice(0, 64)), ['teamrig: this tab is not bound to a session of team app. To bind'], 'no session to show lines to');

    const titled = JSON.stringify({ session_id: CLAUDE_SESSION, session_title: 'app-bravo' });
    const reminded = await kit.run(['hook', 'inbox-reminder'], { stdin: titled, env: { TEAMRIG_SESSION: 'app-bravo' } });
    assert.match(reminded.stdout[0] ?? '', /^INBOX bravo, new in .*\n- 2030-01-08 10:00 UTC alpha: please rebase$/, 'found by its name');
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

  it('refuses a push it would ask about, saying what to do instead, when the team config turns asks off', async () => {
    const kit = new CliHarness({ ...TEAM, prompts: { hookAsks: 'refuse' } });
    for (const command of ['git push origin main', 'git push $ARGS']) {
      const result = await kit.run(['hook', 'push-guard'], { stdin: bash(command) });
      assert.equal(decisionOf(result), 'deny', command);
      assert.ok(reasonOf(result)?.endsWith(` ${ASK_REFUSED_NOTE}`), command);
    }
  });

  it("under pushToProtected lead, lets the lead push and another session only once the lead approved its waiting task (T684)", async () => {
    const kit = new CliHarness({ ...TEAM, pushGuard: { pushToProtected: 'lead' } });
    const push = (env: Record<string, string> = {}) => kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main'), env });
    // A cleared push prints only a note, no permission decision, so the normal permission flow decides.
    assert.match((await push({ TEAMRIG_SESSION: 'lead' })).stdout[0] ?? '', /^\{"systemMessage":"teamrig let this push .* the lead \(lead\) pushes unasked/);
    assert.match(reasonOf(await push()) ?? '', /needs a lead's approval, not the human's: this tab is not bound to a session of the team/);
    assert.match(reasonOf(await push({ TEAMRIG_SESSION: 'alpha' })) ?? '', /: lead has approved no waiting task of alpha's\. Ask on the register/);

    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'branch t1', '--session', 'alpha']);
    assert.equal(decisionOf(await push({ TEAMRIG_SESSION: 'alpha' })), 'deny', 'asked, not yet approved');
    const approved = await kit.run(['approve', 'T1', '--note', 'tests green', '--session', 'lead']);
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    assert.match((await push({ TEAMRIG_SESSION: 'alpha' })).stdout[0] ?? '', /^\{"systemMessage":"teamrig let this push .* lead approved T1; set its next status once pushed/);
    assert.equal(decisionOf(await push({ TEAMRIG_SESSION: 'bravo' })), 'deny', "alpha's approval is not bravo's");
  });

  it('under pushToProtected gated, clears a hand push as lead does and points an uncleared one at merge (T858)', async () => {
    const kit = new CliHarness({ ...TEAM, pushGuard: { pushToProtected: 'gated' } });
    const push = (session: string) => kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main'), env: { TEAMRIG_SESSION: session } });
    assert.match((await push('lead')).stdout[0] ?? '', /pushes unasked \[pushGuard\.pushToProtected: gated\]/);
    assert.match(reasonOf(await push('alpha')) ?? '', /: lead has approved no waiting task of alpha's\. Merge the branch with `teamrig merge` instead/);
  });

  it("under pushToProtected lead, lets a sub-lead's approval clear its member's push (T781)", async () => {
    const kit = new CliHarness({ ...TEAM, leads: { alpha: ['bravo'] }, pushGuard: { pushToProtected: 'lead' } });
    const push = () => kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main'), env: { TEAMRIG_SESSION: 'bravo' } });
    assert.match(reasonOf(await push()) ?? '', /: neither alpha nor lead has approved a waiting task of bravo's\. Ask on the register: `teamrig set <task> --status waiting --waits approval:alpha /);
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'bravo']);
    await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:alpha', '--note', 'branch t1', '--session', 'bravo']);
    assert.equal(decisionOf(await push()), 'deny', 'asked, not yet approved');
    const approved = await kit.run(['approve', 'T1', '--note', 'tests green', '--session', 'alpha']);
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    assert.match((await push()).stdout[0] ?? '', /alpha approved T1; set its next status once pushed/);
  });

  it('refuses a commit that skips the hooks, or asks or lets it run as the team config says, refusing on a broken config', async () => {
    const commit = bash('git commit --no-verify -m fix');
    assert.equal(decisionOf(await new CliHarness().run(['hook', 'push-guard'], { stdin: commit })), 'deny');
    assert.equal(decisionOf(await new CliHarness({ ...TEAM, commitGuard: { skipHooks: 'ask' } }).run(['hook', 'push-guard'], { stdin: commit })), 'ask');
    assert.deepEqual((await new CliHarness({ ...TEAM, commitGuard: { skipHooks: 'allow' } }).run(['hook', 'push-guard'], { stdin: commit })).stdout, []);
    for (const kit of [new CliHarness(null), new CliHarness('{ not json')]) {
      assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: commit })), 'deny');
    }
  });
});

describe('runCli: hook exec-guard', () => {
  const guard = (kit: CliHarness, command: string, env: Record<string, string> = {}) => kit.run(['hook', 'exec-guard'], { stdin: bash(command), env });
  /** The plugin root the harness CLI runs from, the one its entry script sits in. */
  const PLUGIN = clientRootOf(quietWorld().self.script);
  const LAUNCHER = 'bin/teamrig';
  const BUILT = '#!/bin/sh\nexec node main.js\n';
  /** A harness whose plugin install holds a launcher with `launcher` as its text and the list its build wrote for `BUILT`. */
  const installed = async (launcher: string = BUILT): Promise<CliHarness> => {
    const kit = new CliHarness();
    await kit.files.write(join(PLUGIN, CLIENT_MANIFEST), clientManifestText(new Map([[LAUNCHER, clientFileHash(BUILT)]])));
    await kit.files.write(join(PLUGIN, LAUNCHER), launcher);
    return kit;
  };

  it('refuses every exec call while the installed client differs from its build or has no list, and lets other lines be', async () => {
    const patched = await installed('#!/bin/sh\nexec node patched.js\n');
    for (const line of ['teamrig exec status R1', 'teamrig exec approve R1 --session alpha']) {
      assert.match(reasonOf(await guard(patched, line, { TEAMRIG_SESSION: 'alpha' })) ?? '', /the teamrig client was changed after its build \(bin\/teamrig\); reinstall the teamrig plugin or ask security\./, line);
    }
    const bare = new CliHarness();
    assert.match(reasonOf(await guard(bare, 'teamrig exec run R1 --session alpha')) ?? '', /cannot be checked against its build \(dist\/integrity\.json is missing\)/);
    assert.deepEqual((await guard(bare, 'teamrig list')).stdout, []);
  });

  it("lets a bound tab review as itself and refuses it as another session, the owner or no one named (T755)", async () => {
    const kit = await installed();
    const alpha = { TEAMRIG_SESSION: 'alpha' };
    const own = await guard(kit, 'teamrig exec approve R1 --session alpha', alpha);
    assert.deepEqual(own, { code: EXIT.ok, stdout: [], stderr: [] });
    assert.match(reasonOf(await guard(kit, 'teamrig exec approve R1 --session lead', alpha)) ?? '', /names --session lead, but this tab is alpha's/);
    assert.match(reasonOf(await guard(kit, 'teamrig exec refuse R1 --session owner', alpha)) ?? '', /names the owner \(--session owner\); the owner reviews in their own terminal/);
    assert.match(reasonOf(await guard(kit, 'teamrig exec escalate R1', alpha)) ?? '', /names no --session; name this tab's own \(--session alpha\)/);
    assert.equal(decisionOf(await guard(kit, 'node /kit/dist/cli/main.js exec approve R1 --session lead', alpha)), 'deny', 'the CLI run through node');
  });

  it('refuses every review from an unbound tab and lets the other exec commands through to the normal permission flow', async () => {
    const kit = await installed();
    assert.match(reasonOf(await guard(kit, 'teamrig exec approve R1 --session alpha')) ?? '', /this tab is not bound to a session of the team, so the guard cannot tell who reviews/);
    assert.deepEqual((await guard(kit, 'teamrig exec status R1')).stdout, []);
    assert.deepEqual((await guard(kit, 'git status')).stdout, []);
  });
});

describe('runCli: hook secret-guard', () => {
  const read = (file_path: string): string => JSON.stringify({ tool_name: 'Read', tool_input: { file_path }, cwd: APP });

  it('refuses a line or a Read that would print a secret, and lets a line that keeps it off the screen run', async () => {
    const kit = new CliHarness();
    assert.equal(decisionOf(await kit.run(['hook', 'secret-guard'], { stdin: bash('cat .env') })), 'deny');
    assert.equal(decisionOf(await kit.run(['hook', 'secret-guard'], { stdin: read(join(APP, '.env')) })), 'deny');
    assert.deepEqual((await kit.run(['hook', 'secret-guard'], { stdin: bash('cat .env | wc -c') })).stdout, []);
  });

  it('refuses a Write whose text holds a secret, and lets one that writes a secret file run', async () => {
    const kit = new CliHarness();
    const token = ['gh', 'p_', 'a1'.repeat(18)].join('');
    const write = (file_path: string): string => JSON.stringify({ tool_name: 'Write', tool_input: { file_path, content: `send("${token}");` }, cwd: APP });
    assert.equal(decisionOf(await kit.run(['hook', 'secret-guard'], { stdin: write(join(APP, 'src', 'a.ts')) })), 'deny');
    assert.deepEqual((await kit.run(['hook', 'secret-guard'], { stdin: write(join(APP, '.env')) })).stdout, []);
    const readsOff = new CliHarness({ ...TEAM, secretGuard: { secretReads: 'allow' } });
    assert.equal(decisionOf(await readsOff.run(['hook', 'secret-guard'], { stdin: write(join(APP, 'src', 'a.ts')) })), 'deny');
    const writesOff = new CliHarness({ ...TEAM, secretGuard: { writes: 'allow' } });
    assert.deepEqual((await writesOff.run(['hook', 'secret-guard'], { stdin: write(join(APP, 'src', 'a.ts')) })).stdout, []);
  });

  it("asks or lets it run as the team config says, adds the team's own files, and refuses when the config is missing or unreadable", async () => {
    assert.equal(decisionOf(await new CliHarness({ ...TEAM, secretGuard: { secretReads: 'ask' } }).run(['hook', 'secret-guard'], { stdin: bash('cat .env') })), 'ask');
    const asksOff = new CliHarness({ ...TEAM, secretGuard: { secretReads: 'ask' }, prompts: { hookAsks: 'refuse' } });
    assert.equal(decisionOf(await asksOff.run(['hook', 'secret-guard'], { stdin: bash('cat .env') })), 'deny');
    const allows = new CliHarness({ ...TEAM, secretGuard: { secretReads: 'allow' } });
    assert.deepEqual((await allows.run(['hook', 'secret-guard'], { stdin: bash('cat .env') })).stdout, []);
    const own = new CliHarness({ ...TEAM, secretGuard: { paths: ['vault/*.json'] } });
    assert.equal(decisionOf(await own.run(['hook', 'secret-guard'], { stdin: read(join(APP, 'vault', 'db.json')) })), 'deny');
    for (const kit of [new CliHarness(null), new CliHarness('{ not json')]) {
      const result = await kit.run(['hook', 'secret-guard'], { stdin: bash('cat .env') });
      assert.equal(result.code, EXIT.ok);
      assert.equal(decisionOf(result), 'deny');
    }
  });

  it("prints nothing outside a team's projects or for input that is not a hook payload", async () => {
    assert.deepEqual(await new CliHarness(null, null).run(['hook', 'secret-guard'], { stdin: bash('cat .env') }), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.deepEqual(await new CliHarness().run(['hook', 'secret-guard'], { stdin: 'not json' }), { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('runCli: hook secret-redact', () => {
  const token = ['gh', 'p_', 'a1'.repeat(18)].join('');
  const ran = (stdout: string, extra: JsonRecord = {}): string =>
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'run it' }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false }, cwd: APP, ...extra });
  /** The replaced result's stdout, which must no longer hold `secret`, and the line for the model. */
  const redactedOf = (result: CliResult, secret: string): { readonly stdout: string; readonly line: string } => {
    assert.equal(result.code, EXIT.ok);
    const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
    const output = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
    const updated = isRecord(output) ? output['updatedToolOutput'] : undefined;
    assert.ok(isRecord(updated));
    assert.ok(!JSON.stringify(updated).includes(secret), `the result still holds ${secret}`);
    return { stdout: String(updated['stdout']), line: contextOf(result) };
  };

  it("replaces a token in a session's or a helper's result and names the lead to rotate it", async () => {
    const kit = new CliHarness();
    const own = redactedOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(`token ${token}`) }), token);
    assert.equal(own.stdout, 'token [redacted GitHub token]');
    assert.match(own.line, /\(GitHub token\).*ask lead to rotate it/);
    assert.equal(redactedOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(token, { agent_id: 'a1' }) }), token).stdout, '[redacted GitHub token]');
  });

  it("replaces a secret variable's value and a match of the team's own patterns, and names its security reviewer", async () => {
    const kit = new CliHarness({ ...TEAM, roles: { lead: 'lead', securityReviewer: 'bravo' }, register: { secretPatterns: ['hush-[0-9]+'] } });
    const password = ['s3', 'cret', 'Value9'].join('');
    const variable = redactedOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(`DB_PASSWORD=${password}`) }), password);
    assert.match(variable.line, /value of a secret variable.*ask bravo to rotate it/);
    assert.match(redactedOf(await kit.run(['hook', 'secret-redact'], { stdin: ran('code hush-4821') }), 'hush-4821').stdout, /^code \[redacted [^\]]+\]$/);
  });

  it('still redacts when the config is missing or unreadable, naming the lead in words', async () => {
    for (const kit of [new CliHarness(null), new CliHarness('{ not json')]) {
      assert.match(redactedOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(token) }), token).line, /ask the lead to rotate it/);
    }
  });

  it("prints nothing for a clean result, with redaction off, outside a team's projects or for input that is not a hook payload", async () => {
    assert.deepEqual(await new CliHarness().run(['hook', 'secret-redact'], { stdin: ran('all clear') }), { code: EXIT.ok, stdout: [], stderr: [] });
    const off = new CliHarness({ ...TEAM, secretGuard: { redact: false } });
    assert.deepEqual(await off.run(['hook', 'secret-redact'], { stdin: ran(token) }), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.deepEqual(await new CliHarness(null, null).run(['hook', 'secret-redact'], { stdin: ran(token) }), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.deepEqual(await new CliHarness().run(['hook', 'secret-redact'], { stdin: 'not json' }), { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('runCli: hook pass-record-guard', () => {
  const write = (file_path: string): string => JSON.stringify({ tool_name: 'Write', tool_input: { file_path, content: '{}' }, cwd: APP });
  const record = join(APP, '.git', 'local-ci', 'abc.json');

  it('refuses a write of a pass record and a line naming their folder, on a broken config too, and lets other calls run', async () => {
    for (const kit of [new CliHarness(), new CliHarness(null), new CliHarness('{ not json')]) {
      assert.equal(decisionOf(await kit.run(['hook', 'pass-record-guard'], { stdin: write(record) })), 'deny');
      assert.equal(decisionOf(await kit.run(['hook', 'pass-record-guard'], { stdin: bash('rm .git/local-ci/abc.json') })), 'deny');
    }
    const kit = new CliHarness();
    assert.deepEqual(await kit.run(['hook', 'pass-record-guard'], { stdin: write(join(APP, 'notes.md')) }), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.deepEqual(await kit.run(['hook', 'pass-record-guard'], { stdin: bash('git push origin topic') }), { code: EXIT.ok, stdout: [], stderr: [] });
  });

  it("prints nothing outside a team's projects or for input that is not a hook payload", async () => {
    assert.deepEqual(await new CliHarness(null, null).run(['hook', 'pass-record-guard'], { stdin: write(record) }), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.deepEqual(await new CliHarness().run(['hook', 'pass-record-guard'], { stdin: 'not json' }), { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('runCli: hook package-guard', () => {
  it('refuses an npx of a tool not installed and lets one in node_modules/.bin run', async () => {
    const kit = new CliHarness();
    assert.equal(decisionOf(await kit.run(['hook', 'package-guard'], { stdin: bash('npx eslint .') })), 'deny');
    await kit.files.write(join(APP, 'node_modules', '.bin', 'eslint.cmd'), '');
    assert.deepEqual((await kit.run(['hook', 'package-guard'], { stdin: bash('npx eslint .') })).stdout, []);
  });

  it('asks or lets it run as the team config says, and refuses when the config or the pointer is missing, unreadable or cannot be opened', async () => {
    const asks = new CliHarness({ ...TEAM, packageGuard: { adHocRunners: 'ask' } });
    assert.equal(decisionOf(await asks.run(['hook', 'package-guard'], { stdin: bash('pnpm dlx x') })), 'ask');
    const allows = new CliHarness({ ...TEAM, packageGuard: { adHocRunners: 'allow' } });
    assert.deepEqual((await allows.run(['hook', 'package-guard'], { stdin: bash('pnpm dlx x') })).stdout, []);
    const refuses = new CliHarness({ ...TEAM, packageGuard: { adHocRunners: 'ask' }, prompts: { hookAsks: 'refuse' } });
    assert.equal(decisionOf(await refuses.run(['hook', 'package-guard'], { stdin: bash('pnpm dlx x') })), 'deny');
    for (const kit of [new CliHarness(null), new CliHarness('{ not json'), new CliHarness(TEAM, '{ not json')]) {
      const result = await kit.run(['hook', 'package-guard'], { stdin: bash('pnpm dlx x') });
      assert.equal(result.code, EXIT.ok);
      assert.equal(decisionOf(result), 'deny');
    }
    const locked = new CliHarness({ ...TEAM, packageGuard: { adHocRunners: 'allow' } });
    const files = new FaultyFiles(locked.files).fail('read', CONFIG_PATH, systemError('EACCES'));
    assert.equal(decisionOf(await locked.run(['hook', 'package-guard'], { stdin: bash('pnpm dlx x'), files })), 'deny');
  });

  it('refuses an install the registry does not vouch for, under the cooldown the team set, and lets a vetted exact version through', async () => {
    const packageRegistry = new FakePackageRegistry({ lodash: { published: { '4.17.21': '2021-02-20T15:42:16Z', '4.17.22': '2030-01-07T00:00:00Z' } } });
    const kit = new CliHarness();
    assert.deepEqual((await kit.run(['hook', 'package-guard'], { stdin: bash('npm i lodash@4.17.21'), packageRegistry })).stdout, []);
    assert.match(reasonOf(await kit.run(['hook', 'package-guard'], { stdin: bash('npm i lodash@4.17.22'), packageRegistry })) ?? '', /published 1 day ago .* 14-day cooldown/);
    assert.match(reasonOf(await kit.run(['hook', 'package-guard'], { stdin: bash('npm i lodash@4.17.21') })) ?? '', /lodash@4\.17\.21: not on the registry/);
    const noCooldown = new CliHarness({ ...TEAM, packageGuard: { cooldownDays: 0 } });
    assert.deepEqual((await noCooldown.run(['hook', 'package-guard'], { stdin: bash('npm i lodash@4.17.22'), packageRegistry })).stdout, []);
  });

  it("prints nothing outside a team's projects or for input that is not a hook payload", async () => {
    const outside = new CliHarness(null, null);
    assert.deepEqual(await outside.run(['hook', 'package-guard'], { stdin: bash('pnpm dlx x') }), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.deepEqual(await new CliHarness().run(['hook', 'package-guard'], { stdin: 'not json' }), { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('runCli: hook session-start', () => {
  it("loads the core rules, the session's identity and the team's rules", async () => {
    const kit = new CliHarness({ ...TEAM, names: { lead: 'captain' } });
    await kit.files.write(join(KIT, 'teams', 'app', 'rules.md'), 'Ship small.');
    const result = await kit.run(['hook', 'session-start'], { env: { TEAMRIG_SESSION: 'app-alpha' }, stdin: JSON.stringify({ cwd: APP }) });
    assert.equal(result.code, EXIT.ok);
    const text = contextOf(result);
    assert.match(text, /^# Team rules \(teamrig core\)/);
    assert.ok(text.includes('You are the `alpha` session of team `app` (name `app-alpha`). Message the lead as `captain`.'));
    assert.ok(text.endsWith("# Your team's rules\nShip small."));
  });

  it("gives a child team's session the rules of each team above it, root first, before its own", async () => {
    const kit = await treeHarness();
    for (const team of ['app', 'web', 'ui']) {
      await kit.files.write(join(teamHomeOf(team), 'rules.md'), `- ${team} rule.`);
    }
    const result = await kit.run(['hook', 'session-start'], { env: { TEAMRIG_TEAM: 'ui', TEAMRIG_SESSION: 'pixel' }, stdin: JSON.stringify({ cwd: APP }) });
    const above = (team: string) => `# Team ${team}'s rules (a team above yours; they win over a lower team's)\n- ${team} rule.`;
    assert.ok(contextOf(result).endsWith([above('app'), above('web'), "# Your team's rules\n- ui rule."].join('\n\n')));
  });

  it("gives a child team's session the kept local rules of a team above it, tagged with that team", async () => {
    const kit = await treeHarness({ ruleConflicts: [KEPT_PUSH_RULE] });
    const result = await kit.run(['hook', 'session-start'], { env: { TEAMRIG_TEAM: 'ui', TEAMRIG_SESSION: 'pixel' }, stdin: JSON.stringify({ cwd: APP }) });
    assert.ok(contextOf(result).includes(`\nKept local rules [ruleConflicts]:\n${keptPushLineOf('app')}\n`), contextOf(result));
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
    assert.deepEqual(await new CliHarness(CURRENT_TEAM).run(['config', 'validate'], { cwd: join(APP, 'src', 'core') }), VALID);
  });

  it("falls back to the session's project folder", async () => {
    const result = await new CliHarness(CURRENT_TEAM).run(['config', 'validate'], { cwd: ELSEWHERE, env: { CLAUDE_PROJECT_DIR: APP } });
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

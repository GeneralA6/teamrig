import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { formatConfig } from '../config/load.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import { KIT_VERSION } from '../core/version.ts';
import type { RepoState } from '../push-guard/push.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { runCli } from './run.ts';
import { EXIT, type ExitCode } from './runtime.ts';

const USER_HOME = join('/', 'u');
const KIT = join('/', 'kit');
const CONFIG_PATH = join(KIT, 'teams', 'app', 'config.json');
const APP = resolve('/', 'work', 'app');
const POINTER = join(APP, '.teamrig.json');
const CLAUDE_SESSION = '0123abcd-0000-4000-8000-00000000000a';
const TEAM: JsonRecord = { sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead' } };

interface Result {
  readonly code: ExitCode;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

interface RunOptions {
  readonly env?: Env;
  readonly stdin?: string;
  readonly branch?: string;
  readonly cwd?: string;
}

/**
 * The CLI over in-memory files, a fixed clock and a fake git, with the kit home at /kit and the
 * working folder in project /work/app, which a pointer ties to team `app`.
 */
class Harness {
  readonly files: MemoryFiles;
  readonly clock = new FakeClock('2030-01-08T10:00:00Z');

  /** `null` leaves out the team config or the project's team pointer; `undefined` takes the default. */
  constructor(config: JsonRecord | string | null = TEAM, pointer: string | null = '{"team": "app"}') {
    const text = config === null || typeof config === 'string' ? config : formatConfig(config);
    this.files = new MemoryFiles({
      ...(text === null ? {} : { [CONFIG_PATH]: text }),
      ...(pointer === null ? {} : { [POINTER]: pointer }),
    });
  }

  async run(argv: readonly string[], options: RunOptions = {}): Promise<Result> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const git = {
      branch: () => options.branch ?? 'dev',
      pushTarget: () => undefined,
    } satisfies RepoState;
    const code = await runCli(argv, {
      env: { TEAMRIG_HOME: KIT, ...options.env },
      userHome: USER_HOME,
      cwd: options.cwd ?? APP,
      pid: 4242,
      files: this.files,
      clock: this.clock,
      sleep: this.clock.sleep,
      git,
      out: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      readStdin: async () => options.stdin ?? '',
    });
    return { code, stdout, stderr };
  }
}

function bash(command: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: APP });
}

function decisionOf(result: Result): string | undefined {
  const [line] = result.stdout;
  if (line === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === 'object' && parsed !== null && 'hookSpecificOutput' in parsed);
  const output = parsed.hookSpecificOutput;
  assert.ok(typeof output === 'object' && output !== null && 'permissionDecision' in output);
  return String(output.permissionDecision);
}

describe('runCli: help, version and usage errors', () => {
  it('prints the usage for help, and exits 64 with no command', async () => {
    const kit = new Harness();
    const help = await kit.run(['--help']);
    assert.equal(help.code, EXIT.ok);
    assert.match(help.stdout.join('\n'), /^teamrig <command>/);
    assert.equal((await kit.run([])).code, EXIT.usage);
  });

  it('prints the version', async () => {
    assert.deepEqual((await new Harness().run(['--version'])).stdout, [`teamrig ${KIT_VERSION}`]);
  });

  it('exits 64 with the reason and the usage on a line it cannot read', async () => {
    const result = await new Harness().run(['add', '--titel', 'x', '--session', 'alpha']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /^add takes no --titel\n\nteamrig <command>/);
  });
});

describe('runCli: the task register', () => {
  it('adds, lists, sets and shows a task', async () => {
    const kit = new Harness();
    const added = await kit.run(['add', '--title', 'Ship the CLI', '--tier', '2', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    assert.match(added.stdout[0] ?? '', /^ADDED T1 t2 open alpha/);

    const listed = await kit.run(['list'], { env: { TEAMRIG_SESSION: 'alpha' } });
    assert.equal(listed.code, EXIT.ok);
    assert.match(listed.stdout.join('\n'), /^T1 t2 open alpha/m);

    const set = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
    assert.match(set.stdout[0] ?? '', /^SET T1 t2 in-progress alpha/);

    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.equal(shown.code, EXIT.ok);
    assert.match(shown.stdout.join('\n'), /Ship the CLI/);
  });

  it('exits 2 with REFUSED when a team rule refuses a write', async () => {
    const kit = new Harness();
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
    const result = await new Harness(null).run(['list', '--session', 'alpha']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /^REFUSED no team config at /);
  });

  it('reads through a config with problems but refuses to write through it', async () => {
    const kit = new Harness({ ...TEAM, pushGuard: { protectedBranches: 'main' } });
    const listed = await kit.run(['list', '--session', 'alpha']);
    assert.equal(listed.code, EXIT.ok);
    assert.match(listed.stderr[0] ?? '', /^WARN config: 1 problem\(s\), defaults used \(first: pushGuard.protectedBranches/);

    const added = await kit.run(['add', '--title', 'x', '--tier', '1', '--session', 'alpha']);
    assert.equal(added.code, EXIT.refused);
    assert.match(added.stdout[0] ?? '', /^REFUSED the team config has 1 problem\(s\)/);
  });

  it('reads a config from a newer teamrig best-effort but never writes through it', async () => {
    const kit = new Harness({ ...TEAM, configVersion: 99 });
    const listed = await kit.run(['list', '--session', 'alpha']);
    assert.equal(listed.code, EXIT.ok);
    assert.match(listed.stderr[0] ?? '', /config version 99, from a newer teamrig/);
    assert.equal((await kit.run(['add', '--title', 'x', '--tier', '1', '--session', 'alpha'])).code, EXIT.refused);
  });
});

describe('runCli: config', () => {
  it('validates a good config', async () => {
    const result = await new Harness().run(['config', 'validate']);
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, [`VALID ${CONFIG_PATH}`]]);
  });

  it('lists every problem and exits 1', async () => {
    const result = await new Harness({ ...TEAM, pushGuard: { protectedBranches: 'main' } }).run(['config', 'validate']);
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stdout[0] ?? '', /^INVALID .*: 1 problem\(s\)/);
    assert.match(result.stdout[1] ?? '', /^ {2}pushGuard.protectedBranches: /);
  });

  it('reports a config it cannot read at all', async () => {
    const result = await new Harness('{ not json').run(['config', 'validate']);
    assert.equal(result.code, EXIT.failed);
    assert.equal(result.stdout[0], `INVALID ${CONFIG_PATH}`);
    assert.equal((await new Harness(null).run(['config', 'validate'])).code, EXIT.refused);
  });

  it('leaves a current config alone and refuses to migrate a newer one', async () => {
    const current = await new Harness().run(['config', 'migrate']);
    assert.deepEqual([current.code, current.stdout], [EXIT.ok, [`UNCHANGED ${CONFIG_PATH} needs no migration`]]);
    const newer = await new Harness({ ...TEAM, configVersion: 99 }).run(['config', 'migrate']);
    assert.equal(newer.code, EXIT.refused);
    assert.match(newer.stdout[0] ?? '', /^REFUSED .*config version 99, from a newer teamrig; update teamrig instead$/);
  });
});

describe('runCli: session names', () => {
  const NAMED: JsonRecord = { ...TEAM, names: { lead: 'team-lead' }, roles: { lead: 'lead', coordinatorOwner: 'alpha' } };

  it('takes a name wherever it takes a session, and keys everything by id', async () => {
    const kit = new Harness(NAMED);
    const posted = await kit.run(['inbox', 'add', '--to', 'team-lead', '--text', 'ready', '--session', 'app-alpha']);
    assert.match(posted.stdout[0] ?? '', /^POSTED to lead: /);
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
    const result = await new Harness(NAMED).run(['inbox', 'add', '--to', 'app-lead', '--text', 'hi', '--session', 'alpha']);
    assert.deepEqual(
      [result.code, result.stdout[0]],
      [EXIT.refused, 'REFUSED app-lead is not a session on this team (sessions: lead (team-lead), alpha (app-alpha), bravo (app-bravo))'],
    );
  });

  it('still filters by the id of a session no longer on the team, but not by an unknown name', async () => {
    const kit = new Harness(NAMED);
    assert.deepEqual(await kit.run(['list', '--session', 'zulu']), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.match((await kit.run(['inbox', 'status', '--session', 'zulu'])).stdout[0] ?? '', /^INBOX no inbox for zulu in /);
    const long = await kit.run(['list', '--session', 'app-a-name-longer-than-any-session-id']);
    assert.equal(long.code, EXIT.refused);
  });

  it('prints who to message, by id, name or role, or the whole roster', async () => {
    const kit = new Harness(NAMED);
    const names = await Promise.all(['lead', 'team-lead', 'coordinatorOwner', 'bravo'].map((text) => kit.run(['who', text])));
    assert.deepEqual(
      names.map((result) => result.stdout),
      [['team-lead'], ['team-lead'], ['app-alpha'], ['app-bravo']],
    );
    assert.deepEqual((await kit.run(['who'])).stdout, ['lead team-lead (lead)', 'alpha app-alpha (coordinatorOwner)', 'bravo app-bravo']);
  });

  it('refuses who for a role nobody holds or a stranger', async () => {
    const kit = new Harness();
    const role = await kit.run(['who', 'coordinatorOwner']);
    assert.deepEqual([role.code, role.stdout[0]], [EXIT.refused, 'REFUSED no session holds the coordinatorOwner role']);
    assert.equal((await kit.run(['who', 'zulu'])).code, EXIT.refused);
    assert.equal((await kit.run(['who', 'a', 'b'])).code, EXIT.usage);
  });
});

describe('runCli: inboxes', () => {
  it('posts a line, reads it once, then has nothing new', async () => {
    const kit = new Harness();
    const posted = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'the build is green', '--session', 'alpha']);
    assert.equal(posted.code, EXIT.ok, posted.stdout.join('\n'));
    assert.match(posted.stdout[0] ?? '', /^POSTED to bravo: /);

    const status = await kit.run(['inbox', 'status']);
    assert.match(status.stdout.join('\n'), /bravo/);

    const first = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.equal(first.code, EXIT.ok);
    assert.deepEqual(first.stdout.slice(0, 1), ['- 2030-01-08 10:00 alpha: the build is green']);
    assert.match(first.stdout[1] ?? '', /^READ bravo: the 1 line\(s\) above/);

    const again = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.match(again.stdout[0] ?? '', /^READ bravo: nothing new/);
  });

  it('refuses a line to or from someone outside the team, and reading their inbox', async () => {
    const kit = new Harness();
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
    const kit = new Harness();
    const stdin = JSON.stringify({ session_id: CLAUDE_SESSION });
    await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.deepEqual((await kit.run(['hook', 'inbox-reminder'], { stdin })).stdout, []);

    await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'please rebase', '--session', 'alpha']);
    const reminded = await kit.run(['hook', 'inbox-reminder'], { stdin });
    assert.equal(reminded.code, EXIT.ok);
    assert.match(reminded.stdout[0] ?? '', /^INBOX: 1 unread line\(s\) .* teamrig inbox read --session bravo$/);
  });

  it('keeps the reminder hook silent on bad input or without a config', async () => {
    assert.deepEqual(await new Harness().run(['hook', 'inbox-reminder'], { stdin: 'not json' }), { code: EXIT.ok, stdout: [], stderr: [] });
    const noConfig = await new Harness(null).run(['hook', 'inbox-reminder'], { stdin: JSON.stringify({ session_id: CLAUDE_SESSION }) });
    assert.deepEqual(noConfig, { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('runCli: hook push-guard', () => {
  it('asks before a push to a protected branch and refuses a force-push of one', async () => {
    const kit = new Harness();
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main') })), 'ask');
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push --force origin main') })), 'deny');
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin dev') })), undefined);
  });

  it('takes the protected branches from the team config', async () => {
    const kit = new Harness({ ...TEAM, pushGuard: { protectedBranches: ['release'] } });
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main') })), undefined);
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin release') })), 'ask');
  });

  it('keeps the default branches when the config is missing or unreadable', async () => {
    for (const kit of [new Harness(null), new Harness('{ not json')]) {
      const result = await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main') });
      assert.equal(result.code, EXIT.ok);
      assert.equal(decisionOf(result), 'ask');
    }
  });

  it('allows silently on input that is not a hook payload', async () => {
    assert.deepEqual(await new Harness().run(['hook', 'push-guard'], { stdin: 'not json' }), { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('runCli: hook session-start', () => {
  function contextOf(result: Result): string {
    assert.equal(result.stdout.length, 1);
    const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
    assert.ok(typeof parsed === 'object' && parsed !== null && 'hookSpecificOutput' in parsed);
    const output = parsed.hookSpecificOutput;
    assert.ok(typeof output === 'object' && output !== null && 'additionalContext' in output);
    return String(output.additionalContext);
  }

  it("loads the core rules, the session's identity and the team's rules", async () => {
    const kit = new Harness({ ...TEAM, names: { lead: 'team-lead' } });
    await kit.files.write(join(KIT, 'teams', 'app', 'rules.md'), 'Ship small.');
    const result = await kit.run(['hook', 'session-start'], { env: { TEAMRIG_SESSION: 'app-alpha' }, stdin: JSON.stringify({ cwd: APP }) });
    assert.equal(result.code, EXIT.ok);
    const text = contextOf(result);
    assert.match(text, /^# Team rules \(teamrig core\)/);
    assert.ok(text.includes('You are the `alpha` session of team `app` (name `app-alpha`). Message the lead as `team-lead`.'));
    assert.ok(text.endsWith("# Your team's rules\nShip small."));
  });

  it('says why no rules load without a team config', async () => {
    const text = contextOf(await new Harness(null).run(['hook', 'session-start']));
    assert.equal(text, `teamrig is enabled here but team app has no config at ${CONFIG_PATH}, so no team rules are loaded. Write one (see the README), then run: teamrig config validate`);
  });

  it('turns a broken pointer into one line of context', async () => {
    const text = contextOf(await new Harness(TEAM, '{"team": 7}').run(['hook', 'session-start']));
    assert.equal(text, `teamrig: no team, so no team rules: ${POINTER} has no "team" text; expected {"team": "<id>"}`);
  });
});

describe('runCli: which team', () => {
  const VALID = { code: EXIT.ok, stdout: [`VALID ${CONFIG_PATH}`], stderr: [] };
  const SILENT = { code: EXIT.ok, stdout: [], stderr: [] };
  const ELSEWHERE = resolve('/', 'elsewhere');

  it('finds the team from the nearest pointer above the working folder', async () => {
    assert.deepEqual(await new Harness().run(['config', 'validate'], { cwd: join(APP, 'src', 'core') }), VALID);
  });

  it("falls back to the session's project folder", async () => {
    const result = await new Harness().run(['config', 'validate'], { cwd: ELSEWHERE, env: { CLAUDE_PROJECT_DIR: APP } });
    assert.deepEqual(result, VALID);
  });

  it('takes $TEAMRIG_TEAM over the pointer', async () => {
    const result = await new Harness().run(['config', 'validate'], { env: { TEAMRIG_TEAM: 'ops' } });
    assert.equal(result.code, EXIT.refused);
    assert.equal(result.stdout[0], `REFUSED no team config at ${join(KIT, 'teams', 'ops', 'config.json')}`);
  });

  it('refuses a command with no team, naming both ways to set one', async () => {
    const result = await new Harness(TEAM, null).run(['list', '--session', 'alpha']);
    assert.deepEqual(
      [result.code, result.stdout],
      [EXIT.refused, ['REFUSED no team here: set $TEAMRIG_TEAM, or put .teamrig.json {"team": "<id>"} in the project folder']],
    );
  });

  it('refuses a command on a broken pointer, naming the file to fix', async () => {
    const result = await new Harness(TEAM, 'team: app').run(['list', '--session', 'alpha']);
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, [`REFUSED ${POINTER} is not JSON; expected {"team": "<id>"}`]]);
  });

  it('keeps every hook silent outside every team project', async () => {
    const kit = new Harness(TEAM, null);
    assert.deepEqual(await kit.run(['hook', 'push-guard'], { stdin: bash('git push --force origin main') }), SILENT);
    assert.deepEqual(await kit.run(['hook', 'inbox-reminder'], { stdin: JSON.stringify({ session_id: CLAUDE_SESSION }) }), SILENT);
    assert.deepEqual(await kit.run(['hook', 'session-start'], { stdin: JSON.stringify({ cwd: APP }) }), SILENT);
  });

  it("finds a hook's team from the payload's folder, not where the hook process started", async () => {
    const kit = new Harness({ ...TEAM, pushGuard: { protectedBranches: ['release'] } });
    const result = await kit.run(['hook', 'push-guard'], { cwd: ELSEWHERE, stdin: bash('git push origin release') });
    assert.equal(decisionOf(result), 'ask');
  });

  it('still guards the default branches on a broken pointer', async () => {
    const kit = new Harness(TEAM, '{"team": "../app"}');
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main') })), 'ask');
    assert.equal(decisionOf(await kit.run(['hook', 'push-guard'], { stdin: bash('git push --force origin main') })), 'deny');
  });

  it('turns a broken pointer into one line of context instead of a silent inbox', async () => {
    const result = await new Harness(TEAM, '{"team": 7}').run(['hook', 'inbox-reminder'], { stdin: JSON.stringify({ session_id: CLAUDE_SESSION }) });
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [`teamrig: no team, so no inbox reminder: ${POINTER} has no "team" text; expected {"team": "<id>"}`],
      stderr: [],
    });
  });
});

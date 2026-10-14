import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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
const CONFIG_PATH = join(KIT, 'config.json');
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
}

/** The CLI over in-memory files, a fixed clock and a fake git, with the kit home at /kit. */
class Harness {
  readonly files: MemoryFiles;
  readonly clock = new FakeClock('2030-01-08T10:00:00Z');

  /** `null` leaves the kit without a team config; `undefined` would take the default team. */
  constructor(config: JsonRecord | string | null = TEAM) {
    const text = config === null || typeof config === 'string' ? config : formatConfig(config);
    this.files = new MemoryFiles(text === null ? {} : { [CONFIG_PATH]: text });
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
      cwd: join('/', 'work', 'app'),
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
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: join('/', 'work', 'app') });
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
    assert.deepEqual([read.code, read.stdout[0]], [EXIT.refused, 'REFUSED zulu is not a session on this team (sessions: lead, alpha, bravo)']);
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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import type { RequestDraft } from '../exec/request.ts';
import { APP, CliHarness, TEAM, TEAM_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { execDraft } from '../testing/exec-request.ts';
import { FakeCheckout, probeOf } from '../testing/fake-checkout.ts';
import { FakeExecSpawner } from '../testing/fake-exec-spawner.ts';
import { FakeWebhook } from '../testing/fake-webhook.ts';
import { teamConfigOf } from '../testing/team-tree.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import { EXIT } from './runtime.ts';

const EXEC_TEAM: JsonRecord = { ...TEAM, roles: { lead: 'lead', securityReviewer: 'bravo' }, exec: { path: ['C:/nodejs'] } };
/** EXEC_TEAM posting to the security channel whose URL EXEC_WEBHOOK_URL holds. */
const POSTING_TEAM: JsonRecord = { ...EXEC_TEAM, exec: { path: ['C:/nodejs'], webhookEnv: 'EXEC_WEBHOOK_URL' } };
const WEBHOOK_URL = 'https://chat.example/hook';
const WEBHOOK_ENV: Env = { EXEC_WEBHOOK_URL: WEBHOOK_URL };
const REQUEST_FILE = join(APP, 'r1.json');
const AUDIT = join(TEAM_HOME, 'exec', 'audit.jsonl');

interface ExecTeamOptions {
  /** Variables on top of both database ones. */
  readonly env?: Env;
  readonly webhook?: FakeWebhook;
}

/** A team whose exec PATH holds node, run on Windows with both database variables set, over one fake spawner and webhook. */
class ExecTeam {
  readonly kit: CliHarness;
  readonly spawner = new FakeExecSpawner();
  readonly webhook: FakeWebhook;
  private readonly options: RunOptions;

  constructor(config: JsonRecord = EXEC_TEAM, { env = {}, webhook = new FakeWebhook() }: ExecTeamOptions = {}) {
    this.kit = new CliHarness(config);
    this.webhook = webhook;
    this.options = {
      platform: 'win32',
      probe: probeOf('C:/nodejs/node.exe'),
      exec: { spawner: this.spawner, checkout: new FakeCheckout() },
      webhook,
      env: { DB_READ_URI: 'db://read', DB_WRITE_URI: 'db://write', ...env },
    };
  }

  async run(...argv: string[]): Promise<CliResult> {
    return this.kit.run(['exec', ...argv], this.options);
  }

  /** An exec command run from another team of the kit home ($TEAMRIG_TEAM). */
  async runOn(team: string, ...argv: string[]): Promise<CliResult> {
    return this.kit.run(['exec', ...argv], { ...this.options, env: { ...this.options.env, TEAMRIG_TEAM: team } });
  }

  /** alpha's request R1 for `draft`, checked to be logged. */
  async request(draft: RequestDraft = execDraft()): Promise<CliResult> {
    await this.kit.files.write(REQUEST_FILE, JSON.stringify(draft));
    return this.run('request', '--file', 'r1.json', '--session', 'alpha');
  }
}

function outputOf(result: CliResult): string {
  return [...result.stdout, ...result.stderr].join('\n');
}

function assertOk(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, outputOf(result));
}

function assertRefused(result: CliResult, reason: RegExp): void {
  assert.equal(result.code, EXIT.refused, outputOf(result));
  assert.match(outputOf(result), reason);
}

/** `team` with alpha's R1 requested and dry-run. */
async function dryRun(draft: RequestDraft = execDraft(), team: ExecTeam = new ExecTeam()): Promise<ExecTeam> {
  assertOk(await team.request(draft));
  assertOk(await team.run('dry-run', 'R1'));
  return team;
}

describe('runCli: exec request, a privileged command asked for review (T755)', () => {
  it('logs R1 with its programs resolved on the exec PATH, and names the dry run next', async () => {
    const team = new ExecTeam();
    const requested = await team.request();
    assertOk(requested);
    assert.deepEqual(requested.stdout, ['REQUESTED R1: db-write on local app.items for T755; next: teamrig exec dry-run R1']);
    const listed = await team.run('status');
    assert.deepEqual(listed.stdout, ['R1 db-write for T755 by alpha on local app.items: waits for its dry run']);
    assert.match(outputOf(await team.run('status', 'R1')), /run: \["node","tools\/fix-models.ts","--apply"\] \(starts C:[\\/]nodejs[\\/]node\.exe\)/);
    assert.deepEqual(team.spawner.asks, []);
  });

  it('posts the security reviewer one inbox line, also for an owner-gated request', async () => {
    const team = new ExecTeam();
    const requested = await team.request(execDraft({ ownerGated: true }));
    assertOk(requested);
    const line = 'R1 asks to run a db-write on local app.items for T755: review it (teamrig exec status R1)';
    assert.deepEqual(requested.stderr, [`NOTE bravo has an inbox line: ${line}`]);
    const read = await team.kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.deepEqual(read.stdout.filter((text) => text.startsWith('- ')), [`- 2030-01-08 10:00 UTC alpha: ${line}`]);
  });

  it("posts the owner the security reviewer's own request, and every request when no security reviewer is set", async () => {
    const team = new ExecTeam();
    await team.kit.files.write(REQUEST_FILE, JSON.stringify(execDraft()));
    const own = await team.run('request', '--file', 'r1.json', '--session', 'bravo');
    assertOk(own);
    assert.match(own.stderr.join('\n'), /^NOTE owner has an inbox line: R1 asks to run /);
    const unset = new ExecTeam({ ...EXEC_TEAM, roles: { lead: 'lead' } });
    const requested = await unset.request();
    assertOk(requested);
    assert.match(requested.stderr.join('\n'), /^NOTE owner has an inbox line: R1 asks to run /);
  });

  it('refuses a missing file, a file that is not JSON, and a draft with problems', async () => {
    const team = new ExecTeam();
    assertRefused(await team.run('request', '--file', 'r1.json', '--session', 'alpha'), /no request file .*r1\.json/);
    await team.kit.files.write(REQUEST_FILE, '{ not json');
    assertRefused(await team.run('request', '--file', 'r1.json', '--session', 'alpha'), /r1\.json is not JSON: /);
    assertRefused(await team.request(execDraft({ task: 'soon' })), /r1\.json: .*task/);
    assert.deepEqual((await team.run('status')).stdout, [`EXEC no requests in ${AUDIT}`]);
  });

  it('refuses a program that is not on the exec PATH, naming the folders searched', async () => {
    const team = new ExecTeam();
    assertRefused(await team.request(execDraft({ argv: ['python', 'fix.py'] })), /argv\[0\] "python" is not a file on the exec PATH \(exec\.path: C:\/nodejs\)/);
    const bare = new ExecTeam(TEAM);
    assertRefused(await bare.request(), /argv\[0\] "node" is not a file on the exec PATH \(exec\.path names no folder\)/);
  });
});

describe('runCli: exec dry-run and run (T755)', () => {
  it('dry-runs with the read variables only, then runs once with the write ones after approval', async () => {
    const team = await dryRun();
    const [dry] = team.spawner.asks;
    assert.deepEqual(dry?.args, ['tools/fix-models.ts']);
    assert.equal(dry?.env['DB_READ_URI'], 'db://read');
    assert.equal(dry?.env['DB_WRITE_URI'], undefined);
    assert.match(outputOf(await team.run('status')), /R1 .*: dry run exit 0: waits for review/);

    const approved = await team.run('approve', 'R1', '--session', 'bravo');
    assertOk(approved);
    assert.deepEqual(approved.stdout, ['APPROVED R1 by bravo until 2030-01-08T10:30:00.000Z; next: teamrig exec run R1']);
    const ran = await team.run('run', 'R1');
    assertOk(ran);
    assert.match(ran.stdout[0] ?? '', /^RAN R1: exit 0; output .+ \(SHA-256 [0-9a-f]{64}\)$/);
    assert.deepEqual(ran.stdout.slice(1), ['  inserted 12']);
    const run = team.spawner.asks[1];
    assert.deepEqual(run?.args, ['tools/fix-models.ts', '--apply']);
    assert.equal(run?.env['DB_WRITE_URI'], 'db://write');
    assert.equal(run?.env['DB_READ_URI'], undefined);

    assertRefused(await team.run('run', 'R1'), /R1 already ran: an approval is used once/);
    assert.equal(team.spawner.asks.length, 2);
    assert.match(outputOf(await team.run('status')), /R1 .*: ran, exit 0/);
  });

  it('prints the dry run with its next step and its output tail', async () => {
    const team = new ExecTeam();
    assertOk(await team.request());
    const dry = await team.run('dry-run', 'R1');
    assertOk(dry);
    assert.match(dry.stdout[0] ?? '', /^DRY RUN R1: exit 0; output .+ \(SHA-256 [0-9a-f]{64}\); next: the reviewer reads it \(teamrig exec status R1\)/);
    assert.deepEqual(dry.stdout.slice(1), ['  inserted 12']);
  });

  it('fails a nonzero exit without naming a next step', async () => {
    const team = new ExecTeam();
    assertOk(await team.request());
    team.spawner.end = { exitCode: 3, timedOut: false, output: 'boom\n' };
    const dry = await team.run('dry-run', 'R1');
    assert.equal(dry.code, EXIT.failed, outputOf(dry));
    assert.match(dry.stdout[0] ?? '', /^DRY RUN R1: exit 3; output .+ \(SHA-256 [0-9a-f]{64}\)$/);
    assert.deepEqual(dry.stdout.slice(1), ['  boom']);
  });

  it('refuses a run that was never approved', async () => {
    const team = await dryRun();
    assertRefused(await team.run('run', 'R1'), /R1 is not approved/);
    assert.equal(team.spawner.asks.length, 1);
  });

  it('takes only a request id', async () => {
    const team = new ExecTeam();
    const wrong = await team.run('dry-run', 'X1');
    assert.equal(wrong.code, EXIT.usage, outputOf(wrong));
    assert.match(outputOf(wrong), /"X1" is not a request id \(R1, R2, \.\.\.\)/);
  });
});

describe('runCli: exec approve, refuse and escalate (T755)', () => {
  it('lets only the security reviewer or the owner review', async () => {
    const team = await dryRun();
    assertRefused(await team.run('approve', 'R1', '--session', 'alpha'), /alpha reviews nothing: the security reviewer \(bravo\) or the owner \(owner\) reviews R1/);
    assertOk(await team.run('approve', 'R1', '--session', 'owner'));
  });

  it('needs a note to refuse, and a refused request does not run', async () => {
    const team = await dryRun();
    assertRefused(await team.run('refuse', 'R1', '--session', 'bravo'), /a refusal needs a note: the reason and the safe alternative/);
    const refused = await team.run('refuse', 'R1', '--session', 'bravo', '--note', 'use the read tool');
    assertOk(refused);
    assert.deepEqual(refused.stdout, ['DECLINED R1 by bravo: use the read tool']);
    assertRefused(await team.run('run', 'R1'), /R1 was refused by bravo: use the read tool/);
    assert.match(outputOf(await team.run('status')), /R1 .*: refused by bravo/);
  });

  it('refuses a note that looks like a secret, and logs nothing', async () => {
    const team = new ExecTeam({ ...EXEC_TEAM, register: { secretPatterns: ['hunter2'] } });
    assertOk(await team.request());
    assertOk(await team.run('dry-run', 'R1'));
    assertRefused(await team.run('refuse', 'R1', '--session', 'bravo', '--note', 'the key is hunter2'), /the note looks like it holds a secret/);
    assert.doesNotMatch((await team.kit.files.read(AUDIT)) ?? '', /hunter2/);
    assert.match(outputOf(await team.run('status')), /R1 .*: dry run exit 0: waits for review/);
  });

  it('hands an owner-gated request to the owner, who approves it', async () => {
    const team = await dryRun(execDraft({ ownerGated: true }));
    assertRefused(await team.run('approve', 'R1', '--session', 'bravo'), /R1 is owner-gated: the owner \(owner\) approves or refuses it; escalate it with your review note/);
    const escalated = await team.run('escalate', 'R1', '--session', 'bravo', '--note', 'deletes rows');
    assertOk(escalated);
    assert.deepEqual(escalated.stdout, ['ESCALATED R1 by bravo to the owner (owner): deletes rows']);
    assert.match(outputOf(await team.run('status')), /R1 .*: escalated by bravo: waits for the owner/);
    assertRefused(await team.run('run', 'R1'), /R1 is not approved: it waits for the owner/);
    const approved = await team.run('approve', 'R1', '--session', 'owner');
    assertOk(approved);
    assert.match(approved.stdout[0] ?? '', /^APPROVED R1 by owner until /);
  });
});

describe('runCli: exec posts reviews and runs to the security channel (T755)', () => {
  const summary = ' [db-write on local app.items for T755, asked by alpha]';

  function postsOf(team: ExecTeam): string[] {
    return team.webhook.posts.map(({ url, content }) => {
      assert.equal(url, WEBHOOK_URL);
      return content;
    });
  }

  it('posts an approval and its run with the request they settle, and nothing for a request or a dry run', async () => {
    const team = await dryRun(execDraft(), new ExecTeam(POSTING_TEAM, { env: WEBHOOK_ENV }));
    assert.deepEqual(postsOf(team), []);
    const approved = await team.run('approve', 'R1', '--session', 'bravo');
    assertOk(approved);
    assert.deepEqual(approved.stdout, ['APPROVED R1 by bravo until 2030-01-08T10:30:00.000Z; next: teamrig exec run R1']);
    assert.deepEqual(approved.stderr, []);
    team.spawner.end = { exitCode: 3, timedOut: false, output: 'boom\n' };
    const ran = await team.run('run', 'R1');
    assert.equal(ran.code, EXIT.failed, outputOf(ran));
    const [approval, run] = postsOf(team);
    assert.equal(approval, `teamrig exec app: APPROVED R1 by bravo until 2030-01-08T10:30:00.000Z${summary}`);
    assert.match(run ?? '', /^teamrig exec app: RAN R1: exit 3; output SHA-256 [0-9a-f]{64} \[/);
    assert.ok(run?.endsWith(summary), run);
    assert.doesNotMatch(run ?? '', /boom/);
    assertRefused(await team.run('run', 'R1'), /R1 already ran/);
    assert.equal(postsOf(team).length, 2);
  });

  it('posts a refusal and an escalation with their notes', async () => {
    const team = await dryRun(execDraft({ ownerGated: true }), new ExecTeam(POSTING_TEAM, { env: WEBHOOK_ENV }));
    assertOk(await team.run('escalate', 'R1', '--session', 'bravo', '--note', 'deletes rows'));
    assertOk(await team.run('refuse', 'R1', '--session', 'owner', '--note', 'use the read tool'));
    assert.deepEqual(postsOf(team), [
      `teamrig exec app: ESCALATED R1 by bravo to the owner (owner): deletes rows${summary}`,
      `teamrig exec app: DECLINED R1 by owner: use the read tool${summary}`,
    ]);
  });

  it('posts nothing when exec.webhookEnv is unset, and warns when the variable it names is not set', async () => {
    const quiet = await dryRun(execDraft(), new ExecTeam(EXEC_TEAM, { env: WEBHOOK_ENV }));
    const approved = await quiet.run('approve', 'R1', '--session', 'bravo');
    assertOk(approved);
    assert.deepEqual(approved.stderr, []);
    assert.deepEqual(postsOf(quiet), []);
    for (const env of [{}, { EXEC_WEBHOOK_URL: '' }]) {
      const unset = await dryRun(execDraft(), new ExecTeam(POSTING_TEAM, { env }));
      const warned = await unset.run('approve', 'R1', '--session', 'bravo');
      assertOk(warned);
      assert.deepEqual(warned.stderr, ['WARN exec.webhookEnv names EXEC_WEBHOOK_URL, which is not set: nothing posted']);
      assert.deepEqual(postsOf(unset), []);
    }
  });

  it('warns when a post fails, and keeps the exit code', async () => {
    const team = await dryRun(execDraft(), new ExecTeam(POSTING_TEAM, { env: WEBHOOK_ENV, webhook: new FakeWebhook('the webhook answered 500') }));
    const approved = await team.run('approve', 'R1', '--session', 'bravo');
    assertOk(approved);
    assert.deepEqual(approved.stderr, ['WARN R1 is logged, but not posted: the webhook answered 500']);
    const ran = await team.run('run', 'R1');
    assertOk(ran);
    assert.deepEqual(ran.stderr, ['WARN R1 is logged, but not posted: the webhook answered 500']);
  });

  it('posts nothing that looks like a secret', async () => {
    const team = await dryRun(execDraft(), new ExecTeam({ ...POSTING_TEAM, register: { secretPatterns: ['asked by alpha\\]'] } }, { env: WEBHOOK_ENV }));
    const approved = await team.run('approve', 'R1', '--session', 'bravo');
    assertOk(approved);
    assert.match(approved.stderr.join('\n'), /^WARN R1 is logged, but not posted: the post looks like it holds a secret/);
    assert.deepEqual(postsOf(team), []);
  });
});

describe('runCli: exec status (T755)', () => {
  it('shows one request in full with each logged step', async () => {
    const team = await dryRun();
    assertOk(await team.run('approve', 'R1', '--session', 'bravo', '--note', 'counts match'));
    const shown = await team.run('status', 'R1');
    assertOk(shown);
    const text = shown.stdout.join('\n');
    assert.match(shown.stdout[0] ?? '', /^R1 db-write for T755, asked by alpha at 2030-01-08T10:00:00\.000Z: approved by bravo until 2030-01-08T10:30:00\.000Z: ready to run$/);
    assert.match(text, /^ {2}purpose: Refill 12 rows of 3 items$/m);
    assert.match(text, /^ {2}dry run: \["node","tools\/fix-models.ts"\] \(starts .+\) with DB_READ_URI$/m);
    assert.match(text, /^ {2}code: C:\/work\/app at a{40}, lockfile SHA-256 b{64}$/m);
    assert.match(text, /^ {2}dry run: exit 0 at .+; output .+$/m);
    assert.match(text, /^ {4}inserted 12$/m);
    assert.match(text, /^ {2}approved by bravo at .+ until 2030-01-08T10:30:00\.000Z: counts match$/m);
  });

  it('refuses an unknown request and a broken log', async () => {
    const team = new ExecTeam();
    assertRefused(await team.run('status', 'R9'), /no request R9 in the exec audit log/);
    await team.kit.files.write(AUDIT, 'not a line\n');
    assertRefused(await team.run('status'), /the exec audit log is broken at .*audit\.jsonl line 1: .+; nothing more is written to it/);
    assertRefused(await team.request(), /the exec audit log is broken at .*audit\.jsonl line 1: /);
  });
});

/** EXEC_TEAM as a child of team root, leaving its security reviewer to root's (T1143). */
const CHILD_TEAM: JsonRecord = { ...EXEC_TEAM, team: { id: 'app', parent: 'root' }, roles: { lead: 'lead', securityReviewer: 'root/sec' } };
const ROOT_TEAM: JsonRecord = { configVersion: 1, team: { id: 'root' }, sessions: ['lead', 'sec'], roles: { lead: 'lead', securityReviewer: 'sec' } };

/** CHILD_TEAM with its parent root's config written. */
async function childTeam(): Promise<ExecTeam> {
  const team = new ExecTeam(CHILD_TEAM);
  await team.kit.files.write(teamConfigOf('root'), formatConfig(ROOT_TEAM));
  return team;
}

describe('runCli: exec on a child team whose security reviewer sits on a team above (T1143)', () => {
  const line = 'R1 asks to run a db-write on local app.items for T755: review it (teamrig exec status R1 --team app)';

  it("posts the reviewer's team the request from the requester's address, naming the team to review on", async () => {
    const team = await childTeam();
    const requested = await team.request();
    assertOk(requested);
    assert.deepEqual(requested.stderr, [`NOTE root/sec has an inbox line: ${line}`]);
    const read = await team.kit.run(['inbox', 'read', '--session', 'sec'], { env: { TEAMRIG_TEAM: 'root' } });
    assert.deepEqual(read.stdout.filter((text) => text.startsWith('- ')), [`- 2030-01-08 10:00 UTC app/alpha: ${line}`]);
  });

  it('warns when the team above has no config to post to, and the request stands', async () => {
    const team = new ExecTeam(CHILD_TEAM);
    const requested = await team.request();
    assertOk(requested);
    assert.deepEqual(requested.stderr, ['WARN R1 is logged, but root/sec was not told: no team root with a config in this kit home']);
    assert.match(outputOf(await team.run('status')), /^R1 .*: waits for its dry run$/);
  });

  it('lets the reviewer above read and approve it with --team, logged by its address, and the child runs it', async () => {
    const team = await dryRun(execDraft(), await childTeam());
    const listed = await team.runOn('root', 'status', '--team', 'app');
    assertOk(listed);
    assert.deepEqual(listed.stdout, ['R1 db-write for T755 by alpha on local app.items: dry run exit 0: waits for review']);
    const approved = await team.runOn('root', 'approve', 'R1', '--team', 'app', '--session', 'sec');
    assertOk(approved);
    assert.match(approved.stdout[0] ?? '', /^APPROVED R1 by root\/sec until .+; next: teamrig exec run R1$/);
    assertOk(await team.run('run', 'R1'));
  });

  it('lets the owner review with --team too', async () => {
    const team = await dryRun(execDraft(), await childTeam());
    const approved = await team.runOn('root', 'approve', 'R1', '--team', 'app', '--session', 'owner');
    assertOk(approved);
    assert.match(approved.stdout[0] ?? '', /^APPROVED R1 by owner until /);
  });

  it('refuses another session of the team above, a team not below, and an unknown team', async () => {
    const team = await dryRun(execDraft(), await childTeam());
    assertRefused(
      await team.runOn('root', 'approve', 'R1', '--team', 'app', '--session', 'lead'),
      /root\/lead reviews nothing: the security reviewer \(root\/sec\) or the owner \(owner\) reviews R1/,
    );
    assertRefused(await team.run('approve', 'R1', '--team', 'root', '--session', 'bravo'), /team root is not below team app: --team names a team below yours/);
    assertRefused(await team.runOn('root', 'status', '--team', 'ops'), /no team ops with a config in this kit home/);
  });
});

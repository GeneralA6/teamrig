import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { readEvents } from '../register/snapshot.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { SUB_TEAMS, teamConfigOf, teamEventsOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { EXIT } from './runtime.ts';

const STEP = join(APP, 'steps', 'grant-read.ps1');
const STEP_TEXT = 'Write-Host "granted"\n';
const STEP_SHA256 = createHash('sha256').update(STEP_TEXT).digest('hex');
const SHORT = STEP_SHA256.slice(0, 8);
const WEB = { TEAMRIG_TEAM: 'web' };

function filesOf(kit: CliHarness): [string, string | undefined][] {
  return kit.files.paths().map((path) => [path, kit.files.get(path)]);
}

function lastLineOf(text: string | undefined): string | undefined {
  return text?.trimEnd().split('\n').at(-1);
}

/** The audit pin the last line of a register's log carries, if that line is an update. */
function lastPinOf(log: string | undefined): unknown {
  const last = readEvents(log ?? '').events.at(-1);
  assert.ok(last?.type === 'update');
  return last.audit;
}

/** A team whose security reviewer is bravo, with alpha's T1 open and its hand step file written. */
async function reviewed(): Promise<CliHarness> {
  const kit = new CliHarness({ ...TEAM, roles: { lead: 'lead', securityReviewer: 'bravo' } });
  const added = await kit.run(['add', '--title', 'Grant the read', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']);
  assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
  await kit.files.write(STEP, STEP_TEXT);
  return kit;
}

describe('runCli: audit, the security reviewer pins a hand step file for a task (T2312)', () => {
  it("pins the file at its sha256 as one update line, and tells the task's owner", async () => {
    const kit = await reviewed();
    const result = await kit.run(['audit', 'T1', '--file', join('steps', 'grant-read.ps1'), '--note', 'read every line', '--session', 'bravo']);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.match(result.stdout[0] ?? '', /^AUDITED T1 open, p1, owner alpha, from lead \| Grant the read/);
    const told = `bravo audited the hand step ${STEP} for T1 at sha256 ${SHORT}; an edit to it needs a new audit (core rule 11)`;
    assert.deepEqual(result.stderr, [`NOTE alpha has an inbox line: ${told}`]);
    assert.deepEqual(lastPinOf(kit.files.get(EVENTS_PATH)), { path: STEP, sha256: STEP_SHA256 });
    assert.equal(lastLineOf(kit.files.get(teamInboxOf('app', 'alpha'))), `- 2030-01-08 10:00 bravo: ${told}`);
  });

  it("refuses the task's own owner, a session that is not its auditor, a missing file and a file with no run line, writing nothing", async () => {
    const kit = await reviewed();
    await kit.files.write(join(APP, 'steps', 'grant-read.exe'), 'MZ');
    const before = filesOf(kit);
    const refusals: [readonly string[], string][] = [
      [['--file', STEP, '--session', 'alpha'], 'REFUSED alpha owns T1, so it does not audit its own hand step (core rule 11); who audits it: the security reviewer (bravo)'],
      [['--file', STEP, '--session', 'lead'], "REFUSED lead does not audit a hand step of alpha's; who audits it: the security reviewer (bravo)"],
      [['--file', join(APP, 'steps', 'missing.ps1'), '--session', 'bravo'], `REFUSED no file ${join(APP, 'steps', 'missing.ps1')}`],
      [['--file', join(APP, 'steps', 'grant-read.exe'), '--session', 'bravo'], `REFUSED ${join(APP, 'steps', 'grant-read.exe')} is not a hand step file: only .ps1, .sh, .md files have a run line`],
    ];
    for (const [extra, line] of refusals) {
      const result = await kit.run(['audit', 'T1', ...extra]);
      assert.equal(result.code, EXIT.refused, extra.join(' '));
      assert.equal(result.stdout[0], line);
    }
    const bare = await kit.run(['audit', 'T1', '--session', 'bravo']);
    assert.equal(bare.code, EXIT.usage);
    assert.match(bare.stderr[0] ?? '', /--file is required/);
    const blank = await kit.run(['audit', 'T1', '--file', ' ', '--session', 'bravo']);
    assert.equal(blank.code, EXIT.usage);
    assert.match(blank.stderr[0] ?? '', /--file needs the hand step file's path/);
    assert.deepEqual(filesOf(kit), before);
  });

  it('refuses a path with a line break, which a register line would read back as bad, writing nothing', async () => {
    const kit = await reviewed();
    const broken = join(APP, 'steps', 'grant\nread.ps1');
    await kit.files.write(broken, STEP_TEXT);
    const before = filesOf(kit);
    const result = await kit.run(['audit', 'T1', '--file', broken, '--session', 'bravo']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr[0] ?? '', /^--file takes the hand step file's path on one line: a path with a line break is not pinned/);
    assert.deepEqual(filesOf(kit), before);
  });
});

describe('runCli: audit --team, from the reviewer on a team above (T2312)', () => {
  /** The tree under app, web's reviewer being app/alpha, with front's web/T1 open and the hand step file in app's folder. */
  async function reviewedBelow(): Promise<CliHarness> {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], roles: { lead: 'lead', securityReviewer: 'app/alpha' } }));
    const added = await kit.run(['add', '--title', 'Grant the read', '--description', 'what and why', '--priority', 'p1', '--owner', 'front', '--session', 'lead'], { env: WEB });
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    await kit.files.write(STEP, STEP_TEXT);
    return kit;
  }

  it("writes the audit in the child's register by the reviewer's address, and tells the task's owner there", async () => {
    const kit = await reviewedBelow();
    const result = await kit.run(['audit', 'T1', '--team', 'web', '--file', STEP, '--session', 'alpha']);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.match(result.stdout[0] ?? '', /^AUDITED web\/T1 open, p1, owner front, from lead \| Grant the read/);
    const told = `app/alpha audited the hand step ${STEP} for web/T1 at sha256 ${SHORT}; an edit to it needs a new audit (core rule 11)`;
    assert.deepEqual(result.stderr, [`NOTE web/front has an inbox line: ${told}`]);
    assert.deepEqual(lastPinOf(kit.files.get(teamEventsOf('web'))), { path: STEP, sha256: STEP_SHA256 });
    assert.equal(lastLineOf(kit.files.get(teamInboxOf('web', 'front'))), `- 2030-01-08 10:00 app/alpha: ${told}`);
  });

  it('refuses a team not below, a session above that is not the reviewer, and its own team, writing nothing', async () => {
    const kit = await reviewedBelow();
    const before = filesOf(kit);
    const refusals: [readonly string[], Record<string, string>, string][] = [
      [['--session', 'run'], { TEAMRIG_TEAM: 'ops' }, 'REFUSED team web is not below team ops: --team names a team below yours'],
      [['--session', 'bravo'], {}, "REFUSED app/bravo does not audit a hand step of front's; who audits it: the security reviewer (app/alpha), from its own team with --team"],
    ];
    for (const [extra, env, line] of refusals) {
      const result = await kit.run(['audit', 'T1', '--team', 'web', '--file', STEP, ...extra], { env });
      assert.equal(result.code, EXIT.refused, extra.join(' '));
      assert.equal(result.stdout[0], line);
    }
    const own = await kit.run(['audit', 'T1', '--team', 'app', '--file', STEP, '--session', 'alpha']);
    assert.equal(own.code, EXIT.usage);
    assert.match(own.stderr[0] ?? '', /^--team app is your own team: audit T1 without --team/);
    assert.deepEqual(filesOf(kit), before);
  });
});

describe('runCli: set --run, a card hands the owner an audited hand step file (T2312)', () => {
  const asks = ['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'the grant needs the owner', ...TEST_OWNER_CARD_FLAGS, '--session', 'alpha'];

  /** reviewed() with T1 started, so it can wait on the owner. */
  async function started(): Promise<CliHarness> {
    const kit = await reviewed();
    const start = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    assert.equal(start.code, EXIT.ok, start.stderr.join('\n'));
    return kit;
  }

  it('writes the file on the card once its audit pins it, and show prints the line that runs it', async () => {
    const kit = await started();
    const audited = await kit.run(['audit', 'T1', '--file', STEP, '--session', 'bravo']);
    assert.equal(audited.code, EXIT.ok, audited.stderr.join('\n'));
    const handed = await kit.run([...asks, '--run', join('steps', 'grant-read.ps1')]);
    assert.equal(handed.code, EXIT.ok, handed.stderr.join('\n'));
    const shown = (await kit.run(['show', 'T1'])).stdout.join('\n');
    assert.ok(shown.split('\n').includes(`  run: & '${STEP}'   (sha256 ${SHORT}, audited by bravo)`), shown);
  });

  it('refuses a file no audit pins, one changed since its audit, a missing file and a blank path, writing nothing', async () => {
    const kit = await started();
    const unaudited = await kit.run([...asks, '--run', STEP]);
    assert.equal(unaudited.code, EXIT.refused);
    assert.equal(unaudited.stdout[0], `REFUSED no audit on T1 pins ${STEP}: a hand step goes to owner only as a file its auditor read (core rule 11); who audits it: the security reviewer (bravo), with teamrig audit T1 --file ${STEP}`);
    await kit.run(['audit', 'T1', '--file', STEP, '--session', 'bravo']);
    const edited = 'Write-Host "granted to all"\n';
    await kit.files.write(STEP, edited);
    const before = filesOf(kit);
    const changed = await kit.run([...asks, '--run', STEP]);
    assert.equal(changed.code, EXIT.refused);
    const now = createHash('sha256').update(edited).digest('hex').slice(0, 8);
    assert.equal(changed.stdout[0], `REFUSED ${STEP} changed since bravo audited it at sha256 ${SHORT} (now ${now}): an edit needs a new audit (core rule 11)`);
    const missing = join(APP, 'steps', 'missing.ps1');
    const gone = await kit.run([...asks, '--run', missing]);
    assert.deepEqual([gone.code, gone.stdout[0]], [EXIT.refused, `REFUSED no file ${missing}`]);
    const blank = await kit.run([...asks, '--run', ' ']);
    assert.equal(blank.code, EXIT.usage);
    assert.match(blank.stderr[0] ?? '', /--run needs the hand step file's path/);
    assert.deepEqual(filesOf(kit), before);
  });
});

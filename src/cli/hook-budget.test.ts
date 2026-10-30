import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { USAGE_FORMAT } from '../budget/store.ts';
import { WEEK_SUMMARY_FILE } from '../budget/week-summary.ts';
import { WORK_CACHE_FILE } from '../budget/work.ts';
import type { JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { ASK_REFUSED_NOTE } from '../hooks/permission.ts';
import { helperLaunchReminder } from '../rules/helper-default.ts';
import type { Files } from '../core/files.ts';
import { APP, CliHarness, contextOf, decisionOf, KIT, reasonOf, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { replyLine, transcript } from '../testing/transcript-lines.ts';
import { ok } from '../testing/hired-team.ts';
import { teamConfigOf } from '../testing/team-tree.ts';
import { formatConfig } from '../config/load.ts';
import { EXIT } from './runtime.ts';

/** The harness clock is Tuesday 2030-01-08 10:00 UTC; this week resets on Monday 2030-01-14 01:00 UTC, so the pace line is at 19.7%. */
const RESET = Date.parse('2030-01-14T01:00:00Z');
const PROJECT = join(USER_HOME, '.claude', 'projects', 'app');
const ALPHA_TAB = '0000000a-0000-4000-8000-000000000001';
const BRAVO_TAB = '0000000b-0000-4000-8000-000000000002';
const LEAD_TAB = '0000000d-0000-4000-8000-000000000004';
/** A tab no team session read its inbox in. */
const STRANGER_TAB = '0000000f-0000-4000-8000-000000000009';
const ALPHA_TRANSCRIPT = join(PROJECT, `${ALPHA_TAB}.jsonl`);
const LEAD_TRANSCRIPT = join(PROJECT, `${LEAD_TAB}.jsonl`);

/**
 * 1% of the week is 10M W; alpha's weight is a tenth of the lead's and bravo's, so its daily budget is 0.1/2.1 of the
 * team's (99.5 - used) * 24/134: 0.59% of the week at 30% used, 0.81% at 5%; `extra` adds other config sections.
 */
function config(budget: JsonRecord = {}, extra: JsonRecord = {}): JsonRecord {
  return { ...TEAM, budget: { enabled: true, weeklyLimitW: 1_000_000_000, overAction: 'ask-lead', sessions: { alpha: { share: 0.1 } }, ...budget }, ...extra };
}

function reply(id: string, input: number): string {
  return replyLine({ id, requestId: `q-${id}`, at: '2030-01-08T09:00:00.000Z', usage: { input } });
}

/** Alpha's tab used `ownW` today, and its subagent 1M W; the lead's tab used 50M W. */
function transcripts(at: number, ownW: number): MemoryTranscripts {
  const source = new MemoryTranscripts();
  source.set(ALPHA_TRANSCRIPT, transcript([reply('a1', ownW)]), at);
  source.set(join(PROJECT, ALPHA_TAB, 'subagents', 'agent-1.jsonl'), transcript([reply('s1', 1_000_000)]), at);
  source.set(LEAD_TRANSCRIPT, transcript([reply('l1', 50_000_000)]), at);
  return source;
}

/** Claude Code's status input: the week `usedPct` used, resetting at `resetsAt`. */
function status(usedPct: number, resetsAt = RESET): string {
  return JSON.stringify({ session_id: ALPHA_TAB, cwd: APP, workspace: { current_dir: APP }, rate_limits: { seven_day: { used_percentage: usedPct, resets_at: resetsAt / 1000 } } });
}

interface World {
  readonly kit: CliHarness;
  readonly hook: (name: string, tab: string, extra?: JsonRecord, files?: Files) => Promise<CliResult>;
}

/** Alpha's and the lead's tabs read their inboxes; alpha used `ownW` + 1M W today; the week is `usedPct` used. */
async function world(budget: JsonRecord, ownW: number, usedPct: number, extra: JsonRecord = {}): Promise<World> {
  const kit = new CliHarness(config(budget, extra));
  const source = transcripts(kit.clock.now(), ownW);
  await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
  await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: LEAD_TAB } });
  assert.equal((await kit.run(['statusline'], { stdin: status(usedPct) })).code, EXIT.ok);
  const hook = (name: string, tab: string, extra: JsonRecord = {}, files?: Files): Promise<CliResult> => {
    const path = tab === LEAD_TAB ? LEAD_TRANSCRIPT : ALPHA_TRANSCRIPT;
    const stdin = JSON.stringify({ session_id: tab, cwd: APP, transcript_path: path, ...extra });
    return kit.run(['hook', name], { stdin, transcripts: source, ...(files === undefined ? {} : { files }) });
  };
  return { kit, hook };
}

const AGENT = { tool_name: 'Agent', tool_input: { description: 'search', prompt: 'find it' } };

/** A helper launch the budget let go: one line with rule 8's helper default at the default weight, and no decision. */
function remindedOnly(result: CliResult): void {
  assert.equal(decisionOf(result), undefined);
  assert.equal(contextOf(result), helperLaunchReminder(1));
}

function messageOf(result: CliResult): string {
  const [line] = result.stdout;
  assert.ok(line !== undefined, 'no output');
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === 'object' && parsed !== null && 'systemMessage' in parsed && typeof parsed.systemMessage === 'string');
  return parsed.systemMessage;
}

async function leadInbox(kit: CliHarness): Promise<string> {
  return (await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: LEAD_TAB } })).stdout.join('\n');
}

/**
 * Meters the lead's 50M W at its turn end, so the team's day holds 5% of the week besides alpha's: with alpha's 1.1%,
 * past its in-day pace at 30% used (5.2% at 10:00 UTC), so the team has no room today.
 */
async function meterLead({ hook }: World): Promise<void> {
  await hook('stop', LEAD_TAB);
}

describe('the budget in the hooks', () => {
  it('meters the tab and its subagents at the turn end, warns once, and tells the lead once', async () => {
    const team = await world({}, 10_000_000, 30);
    const { kit, hook } = team;
    await meterLead(team);
    const first = await hook('stop', ALPHA_TAB);
    assert.match(
      messageOf(first),
      /^Budget: app-alpha has used 1\.1% of the week today; its daily budget is 0\.59%\. The team has used 6\.1% of the week today, at or past its in-day pace of 5\.2%, and the team is 10\.\d points ahead of its pace line\. The lead has an inbox line\./,
    );
    assert.match(await leadInbox(kit), /alpha: app-alpha is past its daily budget: 1\.1% of the week today against 0\.59%,/);
    assert.deepEqual((await hook('stop', ALPHA_TAB)).stdout, []);
    assert.doesNotMatch(await leadInbox(kit), /past its daily budget/);
  });

  it("tells a sub-lead's member's own leader, not the lead, whose line has it lift the session itself", async () => {
    const team = await world({}, 10_000_000, 30, { leads: { bravo: ['alpha'] } });
    const { kit, hook } = team;
    await meterLead(team);
    assert.match(messageOf(await hook('stop', ALPHA_TAB)), /Its leader app-bravo has an inbox line\./);
    const bravo = (await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: BRAVO_TAB } })).stdout.join('\n');
    assert.match(bravo, /alpha: app-alpha is past its daily budget: 1\.1% of the week today against 0\.59%,.* lift it only with a stop %: teamrig budget lift alpha /);
    assert.doesNotMatch(await leadInbox(kit), /past its daily budget/);
  });

  it("names the group's daily budget a sub-lead's member's lift is a part of", async () => {
    const { kit, hook } = await world({}, 10_000_000, 30, { leads: { bravo: ['alpha'] } });
    const lifted = await kit.run(['budget', 'lift', 'alpha', '--part', '50', '--stop-pct', '97', '--reason', 'release', '--session', 'lead']);
    assert.equal(lifted.code, EXIT.ok, lifted.stderr.join('\n'));
    assert.match(messageOf(await hook('stop', ALPHA_TAB)), /^Budget: app-lead lifted app-alpha to 50\.0% of app-bravo's group's daily budget today /);
  });

  it("counts the subagent's W at budget.subagentWeight", async () => {
    const { hook } = await world({ subagentWeight: 3 }, 8_000_000, 30);
    assert.match(messageOf(await hook('stop', ALPHA_TAB)), /^Budget: app-alpha has used 1\.1% of the week today; its daily budget is 0\.59%\./);
  });

  it('tells the model with the next prompt, once per level', async () => {
    const team = await world({}, 10_000_000, 30);
    const { hook } = team;
    await meterLead(team);
    await hook('stop', ALPHA_TAB);
    // The tab's title, as Claude Code passes it once the prompt hook gave it, so the lines come as plain text.
    const prompt = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next', session_title: 'app-alpha' });
    assert.ok(prompt.stdout.some((line) => line.startsWith("teamrig budget: you are past today's budget")), prompt.stdout.join('\n'));
    const again = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'again', session_title: 'app-alpha' });
    assert.ok(!again.stdout.some((line) => line.startsWith('teamrig budget:')));
  });

  it("reads the week from the status line's week summary, opening no snapshot", async () => {
    const team = await world({}, 10_000_000, 30);
    const { kit, hook } = team;
    await meterLead(team);
    await hook('stop', ALPHA_TAB);
    // Each prompt hook of every tab once read each snapshot in the folder: 18 tabs restored at once outlived the hook's 15 s.
    const snapshotsClosed = new FaultyFiles(kit.files).fail('read', join(KIT, 'usage', 'live', `${ALPHA_TAB}.json`), systemError('EACCES'));
    const prompt = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next', session_title: 'app-alpha' }, snapshotsClosed);
    assert.ok(prompt.stdout.some((line) => line.startsWith("teamrig budget: you are past today's budget")), prompt.stdout.join('\n'));
  });

  it('marks no inbox line shown while the budget step stalls, so a hook killed at its timeout loses none', async () => {
    const { kit, hook } = await world({}, 10_000_000, 30);
    await kit.run(['inbox', 'add', '--to', 'alpha', '--text', 'T7 is yours', '--session', 'lead']);
    const shownPath = join(TEAM_HOME, 'state', 'inbox-shown.jsonl');
    const shownBefore = await kit.files.read(shownPath);
    const weekStalls = new FaultyFiles(kit.files);
    const reached = weekStalls.stall('read', join(KIT, 'usage', 'live', WEEK_SUMMARY_FILE));
    // Claude Code kills the hook at its timeout: this run never ends, and only what it wrote before the stall stays.
    void hook('inbox-reminder', ALPHA_TAB, { prompt: 'next', session_title: 'app-alpha' }, weekStalls);
    await reached;
    assert.equal(await kit.files.read(shownPath), shownBefore);
    const next = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'again', session_title: 'app-alpha' });
    assert.ok(next.stdout.some((line) => line.includes('T7 is yours')), next.stdout.join('\n'));
  });

  it('asks before a helper launch past budget with overAction ask, and lets it go with ask-lead', async () => {
    const asked = await world({ overAction: 'ask' }, 10_000_000, 30);
    await meterLead(asked);
    const gate = await asked.hook('helper-gate', ALPHA_TAB, AGENT);
    assert.equal(decisionOf(gate), 'ask');
    assert.match(gate.stdout[0] ?? '', /alpha is past its daily budget/);
    assert.equal(contextOf(gate), helperLaunchReminder(1));
    const relaxed = await world({}, 10_000_000, 30);
    await meterLead(relaxed);
    remindedOnly(await relaxed.hook('helper-gate', ALPHA_TAB, AGENT));
  });

  it('refuses the launch it would ask about when hook asks are off, saying what to do instead', async () => {
    const refused = await world({ overAction: 'ask' }, 10_000_000, 30, { prompts: { hookAsks: 'refuse' } });
    await meterLead(refused);
    const gate = await refused.hook('helper-gate', ALPHA_TAB, AGENT);
    assert.equal(decisionOf(gate), 'deny');
    assert.ok(reasonOf(gate)?.endsWith(` ${ASK_REFUSED_NOTE}`), reasonOf(gate));
    assert.equal(contextOf(gate), helperLaunchReminder(1));
  });

  it('holds nothing past its part while the team has room today, and escalates once the room runs out', async () => {
    const team = await world({ overAction: 'block' }, 10_000_000, 30);
    const { kit, hook } = team;
    assert.match(
      messageOf(await hook('stop', ALPHA_TAB)),
      /^Budget: app-alpha has used 1\.1% of the week today; its daily budget is 0\.59%\. The team has room today: 1\.1% of the week used, below its in-day pace of 5\.2%, so nothing more happens\./,
    );
    remindedOnly(await hook('helper-gate', ALPHA_TAB, AGENT));
    assert.doesNotMatch(await leadInbox(kit), /past its daily budget/);
    await meterLead(team);
    assert.match(
      messageOf(await hook('stop', ALPHA_TAB)),
      /^Budget: app-alpha is past its daily budget, and the team has used 6\.1% of the week today, at or past its in-day pace of 5\.2%, and the team is 10\.\d points ahead of its pace line\. New helpers are refused; the lead has an inbox line\./,
    );
    assert.equal(decisionOf(await hook('helper-gate', ALPHA_TAB, AGENT)), 'deny');
    assert.match(await leadInbox(kit), /alpha: app-alpha is past its daily budget/);
  });

  it('lets a session past its budget go on with its p0 work, helpers too, and tells its leader so', async () => {
    // Alpha's p0 task weighs 6, so its part is 0.6/2.6 of the team's 12.4%: 2.87%, which its 4.1% today is past.
    const team = await world({ overAction: 'block' }, 40_000_000, 30);
    const { kit, hook } = team;
    ok(await kit.run(['add', '--title', 'Stop the outage', '--description', 'what and why', '--priority', 'p0', '--owner', 'alpha', '--session', 'lead']));
    await meterLead(team);
    assert.match(messageOf(await hook('stop', ALPHA_TAB)), /Its p0 work \(T\d+\) goes on past the stop, helpers too; the lead has an inbox line\./);
    remindedOnly(await hook('helper-gate', ALPHA_TAB, AGENT));
    assert.match(await leadInbox(kit), /alpha: app-alpha is past its daily budget: .* It goes on with its p0 work \(T\d+\) past the stop;/);
  });

  it("counts a session's use today from the week's start on the day the week began", async () => {
    // This week began at 01:00 today: alpha's 50M W at 00:30 was the last week's, so its 10M + 1M W since are today's.
    const kit = new CliHarness(config());
    const source = transcripts(kit.clock.now(), 10_000_000);
    const lastWeek = replyLine({ id: 'a0', requestId: 'q-a0', at: '2030-01-08T00:30:00.000Z', usage: { input: 50_000_000 } });
    source.set(ALPHA_TRANSCRIPT, transcript([lastWeek, reply('a1', 10_000_000)]), kit.clock.now());
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
    assert.equal((await kit.run(['statusline'], { stdin: status(30, Date.parse('2030-01-15T01:00:00Z')) })).code, EXIT.ok);
    const stop = await kit.run(['hook', 'stop'], { stdin: JSON.stringify({ session_id: ALPHA_TAB, cwd: APP, transcript_path: ALPHA_TRANSCRIPT }), transcripts: source });
    assert.match(messageOf(stop), /^Budget: app-alpha has used 1.1% of the week today; .* 1.1% of the week used, below its in-day pace/);
  });

  it('refuses a helper in quiet hours set to block, except for the lead', async () => {
    const { hook } = await world({ quietHours: { startUtc: '09:00', endUtc: '11:00', action: 'block' } }, 1_000_000, 10);
    assert.equal(decisionOf(await hook('helper-gate', ALPHA_TAB, AGENT)), 'deny');
    remindedOnly(await hook('helper-gate', LEAD_TAB, AGENT));
  });

  it('says nothing while the team is behind its pace line, and never posts the lead a line about itself', async () => {
    // At 10% used the in-day pace is 6.7%: the lead's 5% and alpha's 2.1% leave the team no room.
    const behind = await world({}, 20_000_000, 10);
    await meterLead(behind);
    assert.match(
      messageOf(await behind.hook('stop', ALPHA_TAB)),
      /The team has used 7\.1% of the week today, at or past its in-day pace of 6\.7%, but the team is not ahead of its pace line, so nothing more happens\./,
    );
    remindedOnly(await behind.hook('helper-gate', ALPHA_TAB, AGENT));
    const lead = await world({ sessions: { lead: { share: 0.1 } } }, 0, 30);
    assert.match(messageOf(await lead.hook('stop', LEAD_TAB)), /^Budget: app-lead has used 5\.0% of the week today/);
    assert.doesNotMatch(await leadInbox(lead.kit), /past its daily budget/);
  });

  it("tells a session in a burst at its start and its end, the person at the turn end and the model with the prompt", async () => {
    const { kit, hook } = await world({}, 0, 5, { burst: { policy: 'lead', surplusHours: 167 } });
    ok(await kit.run(['burst', 'start', 'surplus', '--reason', 'week-end surplus', '--helpers', '2', '--yes', '--session', 'lead']));
    assert.match(messageOf(await hook('stop', ALPHA_TAB)), /^Budget: the lead started a surplus burst until Mon 01-14 00:00 UTC or 99\.5% of the week: app-alpha's daily budget is at least \d+\.\d%, up to 2 helpers at once\. More: teamrig burst$/);
    assert.deepEqual((await hook('stop', ALPHA_TAB)).stdout, []);
    const told = (await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next', session_title: 'app-alpha' })).stdout;
    assert.ok(told.some((line) => line.startsWith('teamrig burst: a surplus burst runs until Mon 01-14 00:00 UTC') && line.includes('Run up to 2 helpers at once, on independent tasks only')), told.join('\n'));
    assert.ok(!(await hook('inbox-reminder', ALPHA_TAB, { prompt: 'again', session_title: 'app-alpha' })).stdout.some((line) => line.startsWith('teamrig burst:')));
    ok(await kit.run(['burst', 'end', '--reason', 'done early', '--session', 'lead']));
    assert.equal(messageOf(await hook('stop', ALPHA_TAB)), "Budget: app-alpha's burst has ended; its daily budget is 0.81% again.");
    const ended = (await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next', session_title: 'app-alpha' })).stdout;
    assert.ok(ended.some((line) => line.startsWith('teamrig burst: the burst has ended.')), ended.join('\n'));
  });

  it("tells the lead's model once a week when the surplus is worth a burst, and never starts one", async () => {
    const { kit, hook } = await world({}, 0, 5, { burst: { surplusHours: 167 } });
    const prompt = (await hook('inbox-reminder', LEAD_TAB, { prompt: 'next', session_title: 'app-lead' })).stdout;
    const surplus = prompt.find((line) => line.startsWith('teamrig burst: about'));
    assert.ok(surplus !== undefined, prompt.join('\n'));
    assert.match(surplus, /^teamrig burst: about 74\.2% of the week is projected unused at the pace end \(Mon 01-14 00:00 UTC\)\. .* burst\.policy is owner, so first ask the owner, then add --approved-by "<who>"\. More: teamrig burst$/);
    assert.ok(!(await hook('inbox-reminder', LEAD_TAB, { prompt: 'again', session_title: 'app-lead' })).stdout.some((line) => line.startsWith('teamrig burst:')));
    assert.ok(!(await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next', session_title: 'app-alpha' })).stdout.some((line) => line.startsWith('teamrig burst:')), 'only the lead');
    assert.equal(kit.files.get(join(TEAM_HOME, 'state', 'usage', 'bursts.jsonl')), undefined);
  });

  it("tells the lead the team's part of the account's spare when another team shares the account, and nothing once that part is too little", async () => {
    // A second team of three sessions weighs 3 beside the app team's 2.1: the app team's part is 2.1/5.1 of the spare.
    const web = formatConfig({ configVersion: 1, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' } });
    const shared = await world({}, 0, 5, { burst: { surplusHours: 167 } });
    await shared.kit.files.write(teamConfigOf('web'), web);
    const told = (await shared.hook('inbox-reminder', LEAD_TAB, { prompt: 'next', session_title: 'app-lead' })).stdout;
    assert.ok(told.some((line) => /^teamrig burst: about 30\.6% of the week, this team's part of the account's 74\.2%, is projected unused at the pace end /.test(line)), told.join('\n'));
    // At 18% used the account spares 8.4%, which alone would be worth a burst; the team's 3.5% is not.
    const tight = await world({}, 0, 18, { burst: { surplusHours: 167 } });
    await tight.kit.files.write(teamConfigOf('web'), web);
    const quiet = (await tight.hook('inbox-reminder', LEAD_TAB, { prompt: 'next', session_title: 'app-lead' })).stdout;
    assert.ok(!quiet.some((line) => line.startsWith('teamrig burst:')), quiet.join('\n'));
  });

  it('does nothing with the budget off but give a helper launch the helper default', async () => {
    const { hook } = await world({ enabled: false, overAction: 'block' }, 10_000_000, 30);
    assert.deepEqual((await hook('stop', ALPHA_TAB)).stdout, []);
    remindedOnly(await hook('helper-gate', ALPHA_TAB, AGENT));
    const prompt = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next' });
    assert.ok(!prompt.stdout.some((line) => line.startsWith('teamrig budget:')));
  });

  it('prices the helper default at a launch by budget.subagentWeight', async () => {
    const { hook } = await world({ subagentWeight: 2.15 }, 0, 5);
    const gate = await hook('helper-gate', ALPHA_TAB, AGENT);
    assert.equal(decisionOf(gate), undefined);
    assert.equal(contextOf(gate), helperLaunchReminder(2.15));
    assert.match(contextOf(gate), /a helper's tokens cost 2\.15x yours \[budget\.subagentWeight\]/);
  });

  it('stays silent on the budget and never fails a hook when a newer teamrig wrote the usage files', async () => {
    const { kit, hook } = await world({ overAction: 'block' }, 10_000_000, 30);
    await kit.files.write(join(TEAM_HOME, 'state', 'usage', 'alpha.json'), JSON.stringify({ v: USAGE_FORMAT + 1, rev: 1 }));
    const stop = await hook('stop', ALPHA_TAB);
    assert.equal(stop.code, EXIT.ok);
    assert.deepEqual(stop.stdout, []);
    const gate = await hook('helper-gate', ALPHA_TAB, AGENT);
    assert.equal(gate.code, EXIT.ok);
    remindedOnly(gate);
    const prompt = await hook('inbox-reminder', ALPHA_TAB, { prompt: 'next' });
    assert.equal(prompt.code, EXIT.ok);
    assert.ok(!prompt.stdout.some((line) => line.startsWith('teamrig budget:')));
  });

  it('prints nothing for a helper launch outside a team or with a bad payload', async () => {
    const { kit } = await world({ overAction: 'block' }, 10_000_000, 30);
    assert.deepEqual((await kit.run(['hook', 'helper-gate'], { stdin: 'not json' })).stdout, []);
    const elsewhere = join(USER_HOME, 'elsewhere');
    assert.deepEqual((await kit.run(['hook', 'helper-gate'], { stdin: JSON.stringify({ session_id: STRANGER_TAB, cwd: elsewhere, ...AGENT }) })).stdout, []);
    // A bound tab stays a team session in any folder; with no transcript to meter, only the reminder comes.
    remindedOnly(await kit.run(['hook', 'helper-gate'], { stdin: JSON.stringify({ session_id: ALPHA_TAB, cwd: elsewhere, ...AGENT }) }));
  });

  it('holds a session a short day does not fund, with budget.pauseByPriority on, once the team has no room', async () => {
    // At 30% the day has 12.4% of the 14.3% the pace line plans: of the 6.1 weights' 5.3, the lead's 1 first, then 4.3 of bravo's p1 5, none for idle alpha.
    const team = await world({ overAction: 'block', pauseByPriority: true }, 10_000_000, 30);
    const { kit, hook } = team;
    ok(await kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p1', '--owner', 'bravo', '--session', 'lead']));
    await meterLead(team);
    assert.match(
      messageOf(await hook('stop', ALPHA_TAB)),
      /^Budget: app-alpha has used 1\.1% of the week today; its daily budget is 0\.0% \(paused\)\. The team has used 6\.1% of the week today, at or past its in-day pace of 5\.2%, .* New helpers are refused;/,
    );
    assert.equal(decisionOf(await hook('helper-gate', ALPHA_TAB, AGENT)), 'deny');
  });

  it("keeps the register's work in the team's usage folder, and reads the register again once it changes", async () => {
    const { kit, hook } = await world({}, 10_000_000, 30);
    const workCached = (): unknown => parseObject(kit.files.get(join(TEAM_HOME, 'state', 'usage', WORK_CACHE_FILE)) ?? '')?.['work'];
    await hook('stop', ALPHA_TAB);
    assert.deepEqual(workCached(), {});
    ok(await kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']));
    await hook('stop', ALPHA_TAB);
    assert.deepEqual(workCached(), { alpha: { 1: 5 } });
  });
});

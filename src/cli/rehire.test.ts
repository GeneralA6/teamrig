import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectTranscriptPath } from '../budget/discover.ts';
import { decodePrompt, rehirePrompt, resumePrompt } from '../open/prompt.ts';
import { APP, CLAUDE_SESSION, USER_HOME, type CliHarness, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { HELPER_HANDOVER, LEAD_TEAM, ok, teamWithHelper } from '../testing/hired-team.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { EXIT } from './runtime.ts';

const DAY_MS = 86_400_000;
const TRANSCRIPT = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), APP, CLAUDE_SESSION);
const JOB = ['--scope', 'port the exporter', '--reason', 'next release'];
const FOLDERS = new FakePathProbe({ folders: [APP] });
const FRESH_NEXT = 'then open it fresh on its handover: teamrig open helper';

/** A transcript line the way Claude Code writes an assistant reply, with `tokens` of context. */
function reply(tokens: number): string {
  return `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, output_tokens: 50 } } })}\n`;
}

/** A team whose hired `helper` read its inbox in Claude Code session CLAUDE_SESSION, then retired; `retire` adds flags, and no handover then. */
async function retiredHelper(retire: readonly string[] = []): Promise<CliHarness> {
  const kit = await teamWithHelper(LEAD_TEAM, ['port it'], retire.length === 0);
  ok(await kit.run(['inbox', 'read', '--session', 'helper'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } }));
  ok(await kit.run(['retire', 'helper', '--to', 'alpha', ...retire, '--yes', '--session', 'lead']));
  return kit;
}

/** That session's transcript, `tokens` of context, last written `idleDays` ago. */
async function lastSession(kit: CliHarness, tokens: number, idleDays: number): Promise<MemoryTranscripts> {
  await kit.files.write(TRANSCRIPT, reply(tokens));
  return new MemoryTranscripts({ [TRANSCRIPT]: reply(tokens) }, kit.clock.now() - idleDays * DAY_MS);
}

function hire(kit: CliHarness, extra: readonly string[], options: RunOptions = {}): Promise<CliResult> {
  return kit.run(['hire', 'helper', ...JOB, ...extra, '--session', 'lead'], { probe: FOLDERS, ...options });
}

/** Opens a session in a Windows Terminal tab; returns the run and what the tab runs. */
async function open(kit: CliHarness, extra: readonly string[], options: RunOptions = {}): Promise<{ result: CliResult; argv: readonly string[] }> {
  const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
  const result = await kit.run(['open', ...extra], { probe: FOLDERS, processes, platform: 'win32', ...options });
  return { result, argv: processes.started[0]?.args ?? [] };
}

/** The REHIRE line and the line after it (whether it resumes), wherever the hire's own lines end. */
function rehireLines(result: CliResult): [string | undefined, string | undefined] {
  const at = result.stdout.findIndex((line) => line.startsWith('REHIRE '));
  return at < 0 ? [undefined, undefined] : [result.stdout[at], result.stdout[at + 1]];
}

/** The first prompt a tab's launch line carries. */
function promptOf(argv: readonly string[]): string | undefined {
  const encoded = argv[argv.indexOf('--encoded-prompt') + 1];
  return encoded === undefined ? undefined : decodePrompt(encoded);
}

describe('a rehire', () => {
  it('shows the retire and handover it comes back from, and resumes a small, recent last session', async () => {
    const kit = await retiredHelper();
    const transcripts = await lastSession(kit, 120_000, 2);
    const [retired, resumes] = rehireLines(ok(await hire(kit, [], { transcripts })));
    assert.equal(retired, `REHIRE helper retired 2030-01-08 (its job is done); its handover: ${HELPER_HANDOVER}`);
    assert.equal(resumes, `  its last Claude Code session can be resumed: its last Claude Code session ${CLAUDE_SESSION} holds 120000 tokens of context, idle 2.0 day(s)`);
    const hired = ok(await hire(kit, ['--yes'], { transcripts }));
    assert.ok(hired.stdout.at(-1)?.endsWith('then resume its last Claude Code session: teamrig open helper --resume, or open it fresh on its handover: teamrig open helper'), hired.stdout.at(-1));
    const { result, argv } = await open(kit, ['helper', '--resume'], { transcripts });
    assert.ok(ok(result).stdout[0]?.endsWith(`, resuming Claude Code session ${CLAUDE_SESSION}`), result.stdout[0]);
    assert.deepEqual(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2), ['--resume', CLAUDE_SESSION]);
    assert.equal(promptOf(argv), resumePrompt('app', 'helper'));
  });

  it('opens fresh on its handover when its last session is too big, too idle, gone or not on record', async () => {
    const big = await retiredHelper();
    const transcripts = await lastSession(big, 250_001, 1);
    assert.match(rehireLines(ok(await hire(big, [], { transcripts })))[1] ?? '', /^ {2}it opens fresh \(not resumed: .* holds 250001 tokens of context, idle 1\.0 day\(s\): over hiring\.resumeMaxTokens 250000\)$/);
    assert.ok(ok(await hire(big, ['--yes'], { transcripts })).stdout.at(-1)?.endsWith(FRESH_NEXT));
    const refused = (await open(big, ['helper', '--resume'], { transcripts })).result;
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.stdout[0] ?? '', /^REFUSED not resumed: .*over hiring\.resumeMaxTokens 250000; open it fresh on its handover: teamrig open helper$/);
    const { argv } = await open(big, ['helper'], { transcripts });
    assert.equal(promptOf(argv), rehirePrompt('app', 'helper', HELPER_HANDOVER));
    assert.equal(argv.includes('--resume'), false);

    const idle = await retiredHelper();
    assert.match(rehireLines(ok(await hire(idle, [], { transcripts: await lastSession(idle, 1000, 8) })))[1] ?? '', /idle 8\.0 day\(s\): over hiring\.resumeMaxIdleDays 7\)$/);
    const gone = await retiredHelper();
    assert.match(rehireLines(ok(await hire(gone, [])))[1] ?? '', /has no transcript in this project folder\)$/);
    const unread = await teamWithHelper(LEAD_TEAM, ['port it']);
    ok(await unread.run(['retire', 'helper', '--to', 'alpha', '--yes', '--session', 'lead']));
    assert.equal(rehireLines(ok(await hire(unread, [])))[1], '  it opens fresh (not resumed: no Claude Code session of it is on record)');
  });

  it('says why it left no handover, and then opens plainly', async () => {
    const kit = await retiredHelper(['--no-handover', 'nothing worth keeping']);
    const hired = ok(await hire(kit, ['--yes']));
    assert.equal(rehireLines(hired)[0], 'REHIRE helper retired 2030-01-08 (its job is done); it left no handover: nothing worth keeping');
    assert.ok(hired.stdout.at(-1)?.endsWith('then open it fresh: teamrig open helper'), hired.stdout.at(-1));
    const { argv } = await open(kit, ['helper']);
    assert.match(promptOf(argv) ?? '', /^You are the helper session of team app\. Run `teamrig inbox read`/);
  });

  it('starts fresh, with why, when its last session cannot be measured', async () => {
    const kit = await retiredHelper();
    const transcripts = await lastSession(kit, 1000, 1);
    const files = new FaultyFiles(kit.files).fail('readTail', TRANSCRIPT, systemError('EACCES'));
    assert.match(rehireLines(ok(await hire(kit, [], { transcripts, files })))[1] ?? '', /^ {2}it opens fresh \(not resumed: its last Claude Code session could not be measured: .*EACCES/);
  });

  it('hired home with no room on the host, opens on its handover, not resumed (T1364)', async () => {
    const kit = await retiredHelper();
    const transcripts = await lastSession(kit, 120_000, 2);
    const memory = new FakeHostMemory();
    memory.free = 100;
    const hired = ok(await hire(kit, ['--yes'], { transcripts, memory }));
    const resumable = 'resume its last Claude Code session: teamrig open helper --resume, or open it fresh on its handover: teamrig open helper';
    assert.ok(hired.stdout.at(-1)?.endsWith(`; or, once the host has room, ${resumable}`), hired.stdout.at(-1));
    const { result, argv } = await open(kit, ['helper'], { transcripts });
    ok(result);
    assert.equal(argv.includes('--resume'), false);
    assert.equal(promptOf(argv), rehirePrompt('app', 'helper', HELPER_HANDOVER));
  });

  it('is the only open --resume takes, and a given prompt wins over the rehire prompt', async () => {
    const kit = await retiredHelper();
    const transcripts = await lastSession(kit, 1000, 1);
    const alpha = (await open(kit, ['alpha', '--resume'], { transcripts })).result;
    assert.deepEqual(alpha.stdout, ["REFUSED alpha was neither hired back after a retire nor closed: --resume resumes only a rehired session's last Claude Code session"]);
    ok(await hire(kit, ['--yes'], { transcripts }));
    assert.equal(promptOf((await open(kit, ['helper', '--resume', '--prompt', 'Ship it'], { transcripts })).argv), 'Ship it');
    assert.equal(promptOf((await open(kit, ['helper', '--prompt', 'Ship it'])).argv), 'Ship it');
  });
});

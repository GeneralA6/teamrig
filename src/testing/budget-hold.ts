import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { APP, USER_HOME, type CliHarness } from './cli-harness.ts';
import { ok } from './hired-team.ts';
import { MemoryTranscripts } from './memory-transcripts.ts';
import { replyLine, transcript } from './transcript-lines.ts';

/** A budget on which 1% of the week is 10M W, and alpha's share a tenth of the lead's and bravo's. */
export const HOLDING_BUDGET: JsonRecord = { enabled: true, weeklyLimitW: 1_000_000_000, overAction: 'ask-lead', sessions: { alpha: { share: 0.1 } } };

/** The harness clock is Tuesday 2030-01-08 10:00 UTC; this week resets on Monday 2030-01-14 01:00 UTC. */
const RESET = Date.parse('2030-01-14T01:00:00Z');
const PROJECT = join(USER_HOME, '.claude', 'projects', 'app');
const ALPHA_W = 100_000_000;
const LEAD_W = 50_000_000;

/**
 * Holds alpha by its budget, in a team on {@link HOLDING_BUDGET} at the harness clock: the status line has the week
 * 30% used, so the team's daily budget is 12.4% of the week and its in-day pace 5.2%; alpha's tab `alphaTab` and the
 * lead's `leadTab` are metered at 100M and 50M W today. That is 10% of the week for alpha, past any part its tenth
 * share reaches with a few tasks queued (4.4% with a p0 and a p1), and 15% for the team: no room today.
 */
export async function holdAlpha(kit: CliHarness, alphaTab: string, leadTab: string): Promise<void> {
  const source = new MemoryTranscripts();
  for (const [id, tab, input] of [['alpha', alphaTab, ALPHA_W], ['lead', leadTab, LEAD_W]] as const) {
    ok(await kit.run(['inbox', 'read', '--session', id], { env: { CLAUDE_CODE_SESSION_ID: tab } }));
    source.set(join(PROJECT, `${tab}.jsonl`), transcript([replyLine({ id: `${id}-1`, requestId: `q-${id}`, at: '2030-01-08T09:00:00.000Z', usage: { input } })]), kit.clock.now());
  }
  const status = { session_id: alphaTab, cwd: APP, workspace: { current_dir: APP }, rate_limits: { seven_day: { used_percentage: 30, resets_at: RESET / 1000 } } };
  ok(await kit.run(['statusline'], { stdin: JSON.stringify(status) }));
  for (const tab of [leadTab, alphaTab]) {
    ok(await kit.run(['hook', 'stop'], { stdin: JSON.stringify({ session_id: tab, cwd: APP, transcript_path: join(PROJECT, `${tab}.jsonl`) }), transcripts: source }));
  }
}

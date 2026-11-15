import type { TeamPaths } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import type { SessionProcesses } from '../open/session-processes.ts';
import { TabNeedStore } from '../tabs/need.ts';
import type { AskingTab } from '../tabs/needs-you.ts';
import { heldPrompts, PromptHoldsPaged, promptHoldText } from '../tabs/prompt-hold.ts';
import type { Kit } from './kit.ts';
import { sendOwnerPage } from './login-page.ts';
import type { CliRuntime } from './runtime.ts';
import type { UnownedWarning } from './unowned.ts';

/** The team's tabs held on a permission prompt now (src/tabs/prompt-hold.ts). */
async function heldNow(runtime: Pick<CliRuntime, 'files'> & { readonly sessionProcesses: Pick<SessionProcesses, 'alive'> }, paths: Pick<TeamPaths, 'tabs'>, now: number): Promise<AskingTab[]> {
  const tabs = await new TabNeedStore(runtime.files, paths).readAll();
  return heldPrompts(tabs, now, (pid) => runtime.sessionProcesses.alive(pid));
}

/**
 * Pages the owner once for each of the team's tabs held on a permission prompt (T2927), through the page webhook the
 * team's alerts or a team's above name, as an expired login pages. Run by the idle pass under its lock, so one tab of
 * the team pages each hold. A hold with no webhook up the tree counts as paged: `check` still shows it. A post that
 * fails is left unpaged for the next pass to try again, and its problem is returned for the caller to warn of.
 */
export async function pagePromptHolds(runtime: CliRuntime, kit: Kit, now: number): Promise<string[]> {
  const { team } = kit.paths;
  const held = await heldNow(runtime, kit.paths, now);
  const store = new PromptHoldsPaged(runtime.files, kit.paths.promptHoldsPaged);
  const failed: AskingTab[] = [];
  const problems: string[] = [];
  for (const need of await store.unpaged(held)) {
    const where = `${team}/${need.session}`;
    const page = await sendOwnerPage(runtime, team, (zone) => promptHoldText(where, need, (at) => zone.clock(at), now));
    if (page.status === 'problem') {
      failed.push(need);
      problems.push(`the page of ${where}'s permission prompt hold failed (${page.problem}); the next idle pass tries again`);
    }
  }
  await store.keep(held, failed);
  return problems;
}

/**
 * PROMPT-HELD (T2927), for `check`: each of the team's tabs held on a permission prompt, a warning no session owns,
 * since the held session cannot see it and only a person at that tab can answer; it goes to the lead. Its key names
 * the hold, so the lead is told once a hold.
 */
export async function promptHoldWarnings(runtime: Pick<CliRuntime, 'files'> & { readonly sessionProcesses: Pick<SessionProcesses, 'alive'> }, paths: Pick<TeamPaths, 'tabs' | 'team'>, zone: TimeZone, now: number): Promise<UnownedWarning[]> {
  const held = await heldNow(runtime, paths, now);
  return held.map((need) => ({
    key: `prompt-hold ${need.session} ${need.since}`,
    source: 'the prompt-hold check of the tab files',
    text: `PROMPT-HELD ${promptHoldText(`${paths.team}/${need.session}`, need, (at) => zone.clock(at), now)}`,
  }));
}

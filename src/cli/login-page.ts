import type { AlertsConfig } from '../config/types.ts';
import type { TimeZone } from '../core/zone.ts';
import { loginPageText } from '../restore/login.ts';
import { openKit, teamZone } from './kit.ts';
import type { CliRuntime } from './runtime.ts';

/** The alerts keys that name where the owner's page goes; the file key wins over the environment key. */
export type PageKey = keyof Pick<AlertsConfig, 'pageWebhookFile' | 'pageWebhookEnv'>;

/** Where the owner's page goes: the team whose config names it, by which key and value (never the URL itself). */
export interface PageSource {
  readonly team: string;
  readonly key: PageKey;
  readonly value: string;
}

/** The owner's page for an expired login: where it goes, and its line. */
export interface LoginPage {
  readonly source: PageSource;
  readonly text: string;
}

/**
 * The first team from `team` up its `team.parent` links whose alerts name a page webhook; undefined when none does,
 * or a config on the way does not load. A loop of parent links ends at the first team met again.
 */
async function pageSourceOf(runtime: CliRuntime, team: string): Promise<{ readonly source: PageSource; readonly zone: TimeZone } | undefined> {
  const seen = new Set<string>();
  let zone: TimeZone | undefined;
  for (let current: string | undefined = team; current !== undefined && !seen.has(current); ) {
    seen.add(current);
    const { load } = await openKit(runtime, current);
    if (load.status !== 'loaded') {
      return undefined;
    }
    const { config } = load;
    // The time is read on the tab's own team's clock, wherever the key sits.
    zone ??= teamZone(config, runtime);
    const { pageWebhookFile, pageWebhookEnv } = config.alerts;
    if (pageWebhookFile !== undefined) {
      return { source: { team: current, key: 'pageWebhookFile', value: pageWebhookFile }, zone };
    }
    if (pageWebhookEnv !== undefined) {
      return { source: { team: current, key: 'pageWebhookEnv', value: pageWebhookEnv }, zone };
    }
    current = config.team?.parent;
  }
  return undefined;
}

/**
 * The page a failure of a tab of `team` (`session`, when `teamrig launch` started it) at `at` sends, or undefined
 * when no team up the tree names a page webhook. The tab is named by team and session alone: the Claude session id
 * means nothing to the owner.
 */
export async function loginPageOf(runtime: CliRuntime, team: string, session: string | undefined, at: number): Promise<LoginPage | undefined> {
  const found = await pageSourceOf(runtime, team);
  if (found === undefined) {
    return undefined;
  }
  const tab = session === undefined ? `a tab of team ${team}` : `${team}/${session}`;
  return { source: found.source, text: loginPageText(tab, found.zone.clock(new Date(at))) };
}

/** The webhook URL a source names, else why there is none, in words that hold neither the URL nor the file's path. */
async function pageUrlOf(source: PageSource, runtime: CliRuntime): Promise<{ readonly url: string } | { readonly problem: string }> {
  if (source.key === 'pageWebhookEnv') {
    const url = runtime.env[source.value]?.trim();
    return url === undefined || url === '' ? { problem: `alerts.pageWebhookEnv names ${source.value}, which is not set` } : { url };
  }
  let text: string | undefined;
  try {
    text = await runtime.files.read(source.value);
  } catch {
    return { problem: 'the file alerts.pageWebhookFile names cannot be read' };
  }
  const url = text
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  return url === undefined ? { problem: 'the file alerts.pageWebhookFile names is missing or empty' } : { url };
}

/** Posts the page; undefined once it is posted, else why not. It never throws, so a claim is never left held by one. */
export async function sendLoginPage(page: LoginPage, runtime: CliRuntime): Promise<string | undefined> {
  try {
    const found = await pageUrlOf(page.source, runtime);
    return 'problem' in found ? found.problem : await runtime.webhook.post(found.url, page.text);
  } catch {
    return 'the webhook post failed';
  }
}

/** The restore log's line for a page: where it went, or why it did not. */
export function loginPageLogLine(page: LoginPage, problem: string | undefined): string {
  return problem === undefined
    ? `login: paged the owner through ${page.source.team}'s alerts.${page.source.key}`
    : `login: the page to the owner failed (${problem}); the next failure pages`;
}

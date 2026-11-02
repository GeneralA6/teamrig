import { loginPageText } from "../restore/login.js";
import { openKit, teamZone } from "./kit.js";
/**
 * The first team from `team` up its `team.parent` links whose alerts name a page webhook; undefined when none does,
 * or a config on the way does not load. A loop of parent links ends at the first team met again.
 */
async function pageSourceOf(runtime, team) {
    const seen = new Set();
    let zone;
    for (let current = team; current !== undefined && !seen.has(current);) {
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
export async function loginPageOf(runtime, team, session, at) {
    const found = await pageSourceOf(runtime, team);
    if (found === undefined) {
        return undefined;
    }
    const tab = session === undefined ? `a tab of team ${team}` : `${team}/${session}`;
    return { source: found.source, text: loginPageText(tab, found.zone.clock(new Date(at))) };
}
/** The webhook URL a source names, else why there is none, in words that hold neither the URL nor the file's path. */
async function pageUrlOf(source, runtime) {
    if (source.key === 'pageWebhookEnv') {
        const url = runtime.env[source.value]?.trim();
        return url === undefined || url === '' ? { problem: `alerts.pageWebhookEnv names ${source.value}, which is not set` } : { url };
    }
    let text;
    try {
        text = await runtime.files.read(source.value);
    }
    catch {
        return { problem: 'the file alerts.pageWebhookFile names cannot be read' };
    }
    const url = text
        ?.split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '');
    return url === undefined ? { problem: 'the file alerts.pageWebhookFile names is missing or empty' } : { url };
}
/** Posts the page; undefined once it is posted, else why not. It never throws, so a claim is never left held by one. */
export async function sendLoginPage(page, runtime) {
    try {
        const found = await pageUrlOf(page.source, runtime);
        return 'problem' in found ? found.problem : await runtime.webhook.post(found.url, page.text);
    }
    catch {
        return 'the webhook post failed';
    }
}
/** The restore log's line for a page: where it went, or why it did not. */
export function loginPageLogLine(page, problem) {
    return problem === undefined
        ? `login: paged the owner through ${page.source.team}'s alerts.${page.source.key}`
        : `login: the page to the owner failed (${problem}); the next failure pages`;
}

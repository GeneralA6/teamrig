import { KIT_NAME } from "../core/home.js";
import { secretValueOf } from "../core/secret-key.js";
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
        const { pageWebhookFile, pageWebhookKey, pageWebhookEnv } = config.alerts;
        if (pageWebhookFile !== undefined) {
            const fileKey = pageWebhookKey === undefined ? {} : { fileKey: pageWebhookKey };
            return { source: { team: current, key: 'pageWebhookFile', value: pageWebhookFile, ...fileKey }, zone };
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
/** Resolves the page URL `team`'s alerts name, as `sendLoginPage` would, and posts nothing. */
export async function pageCheckOf(runtime, team) {
    const found = await pageSourceOf(runtime, team);
    if (found === undefined) {
        return { status: 'none' };
    }
    const { source } = found;
    const url = await pageUrlOf(source, runtime);
    return 'problem' in url ? { status: 'problem', source, problem: url.problem } : { status: 'ok', source };
}
/** The test page's line: marked TEST, so whoever reads the chat knows nothing is wrong. */
export function testPageText(team, clock) {
    return `TEST page from ${KIT_NAME} page test, team ${team}, at ${clock}: an expired Claude login would page you here. Nothing to do.`;
}
/**
 * Posts one test page through the page webhook `team`'s alerts name, the same way a login expiry's page goes:
 * `ok` once it is posted, `problem` with why not, `none` when no team up the tree names one.
 */
export async function sendTestPage(runtime, team) {
    const found = await pageSourceOf(runtime, team);
    if (found === undefined) {
        return { status: 'none' };
    }
    const { source, zone } = found;
    const problem = await sendLoginPage({ source, text: testPageText(team, zone.clock(new Date(runtime.clock.now()))) }, runtime);
    return problem === undefined ? { status: 'ok', source } : { status: 'problem', source, problem };
}
/** The webhook URL a source names, else why there is none, in words that hold neither the URL nor the file's path. */
async function pageUrlOf(source, runtime) {
    const found = await namedUrlOf(source, runtime);
    // An https URL only: a page posted in the clear would hand the webhook's token, half its URL, to the network.
    return 'url' in found && !isHttpsUrl(found.url) ? { problem: `the webhook URL alerts.${source.key} gives is not an https URL` } : found;
}
async function namedUrlOf(source, runtime) {
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
    if (text === undefined) {
        return { problem: 'the file alerts.pageWebhookFile names is missing or empty' };
    }
    return source.fileKey === undefined ? firstLineUrl(text) : keyedUrl(text, source.fileKey);
}
function firstLineUrl(text) {
    const url = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '');
    return url === undefined ? { problem: 'the file alerts.pageWebhookFile names is missing or empty' } : { url };
}
/** The URL `key` holds in a secrets file's text; the problem names the key, never a value. */
function keyedUrl(text, key) {
    const url = secretValueOf(text, key)?.trim();
    if (url === undefined) {
        return { problem: `the file alerts.pageWebhookFile names has no ${key} line, or its quote is not closed` };
    }
    return url === '' ? { problem: `the file alerts.pageWebhookFile names gives ${key} no value` } : { url };
}
function isHttpsUrl(text) {
    return URL.canParse(text) && new URL(text).protocol === 'https:';
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

import { isRecord, numberField, stringField } from "../core/guards.js";
import { parseObject, recordVersion, VERSION_FIELD } from "../core/jsonl.js";
/**
 * The team's week summary: its used and planned part of the account's week, kept by the budget hooks
 * (src/budget/team-week-file.ts) for a reader that shows each team's week without recomputing the budget, as the
 * pane's Teams tab does. One file per team, in its own folder: a child team keeps its own, and a reader that shows a
 * parent with its children adds theirs to it. It sits at `TEAM_WEEK_IN_STATE` under the team's state folder
 * (`<kit home>/teams/<team>/state`, unless the team config's `paths.state` moves it); the format, one JSON object:
 *
 * - `v`: `TEAM_WEEK_FORMAT`;
 * - `account`: the Claude account whose week the percents are of, as teamrig tells accounts apart (src/budget/account.ts
 *   `accountsOf`): the `budget.account` the team names, else the config dir its sessions run in. A reader adds up only
 *   files that name one account: teams on two accounts each have a week of their own;
 * - `usedPct`: the team's use since the week began, in percent of the account's week: its sessions' W at the team's
 *   own W per percent (the use outside every team is no team's);
 * - `plannedPct`: the team's use by the week's end as planned: `usedPct` plus its part (src/budget/parts.ts
 *   `teamShareOf`) of what the account has left to `budget.targetPct`;
 * - `accountUsedPct`: the account's use of the week, in percent: every team's and the use outside them;
 * - `resetsAt`: the week's reset, epoch ms;
 * - `at`: when it was read, epoch ms, to the minute;
 * - `limits`: the stretches the account's week sat at its usage limit, oldest first, each `{ start, end }` in epoch ms
 *   (src/budget/extra.ts `limitSpansOf`), for a reader that marks those days but cannot load the meter log, as the
 *   pane's Stats tab. Every team on the account writes the same list, at most one stretch a period the log still keeps.
 *
 * Percents are rounded to two decimals. A hook of any of the team's sessions rewrites it when that changes it. Format 1
 * had every field but `account` and `limits`; it is still read, naming no account and no stretch, since a team whose
 * sessions are idle keeps its file until a hook of it runs again.
 */
export const TEAM_WEEK_IN_STATE = ['usage', 'team.week.json'];
/** The team week summary's format; a field added to it raises this. */
export const TEAM_WEEK_FORMAT = 2;
/** The format before `account` and `limits`, still read for a team whose hooks have not written since. */
const UNNAMED_FORMAT = 1;
/** The summary as its file's text. */
export function formatTeamWeek(summary) {
    const { account, usedPct, plannedPct, accountUsedPct, resetsAt, at, limits } = summary;
    return JSON.stringify({ [VERSION_FIELD]: TEAM_WEEK_FORMAT, account, usedPct, plannedPct, accountUsedPct, resetsAt, at, limits });
}
/** One stored stretch; undefined when it is damaged: a stretch ends after it starts. */
function parseLimitSpan(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const start = numberField(value, 'start');
    const end = numberField(value, 'end');
    return start === undefined || end === undefined || start >= end ? undefined : { start, end };
}
/** The stored stretches; undefined when the list is missing or any of it is damaged. */
function parseLimits(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const spans = value.flatMap((entry) => {
        const span = parseLimitSpan(entry);
        return span === undefined ? [] : [span];
    });
    return spans.length === value.length ? spans : undefined;
}
/** The summary file's text; undefined when it is damaged or in a format this teamrig cannot read. */
export function parseTeamWeek(text) {
    const parsed = parseObject(text);
    const version = parsed === undefined ? undefined : recordVersion(parsed);
    if (parsed === undefined || (version !== TEAM_WEEK_FORMAT && version !== UNNAMED_FORMAT)) {
        return undefined;
    }
    const account = stringField(parsed, 'account');
    const usedPct = numberField(parsed, 'usedPct');
    const plannedPct = numberField(parsed, 'plannedPct');
    const accountUsedPct = numberField(parsed, 'accountUsedPct');
    const resetsAt = numberField(parsed, 'resetsAt');
    const at = numberField(parsed, 'at');
    if (usedPct === undefined || plannedPct === undefined || accountUsedPct === undefined || resetsAt === undefined || at === undefined) {
        return undefined;
    }
    if (version === UNNAMED_FORMAT) {
        return { account: undefined, usedPct, plannedPct, accountUsedPct, resetsAt, at, limits: [] };
    }
    const limits = parseLimits(parsed['limits']);
    return account === undefined || limits === undefined ? undefined : { account, usedPct, plannedPct, accountUsedPct, resetsAt, at, limits };
}

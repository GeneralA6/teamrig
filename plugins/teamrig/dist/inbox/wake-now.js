import { formatW } from "../budget/format.js";
import { WAKE_TICK_MS } from "../mod/wake-hand.js";
import { costText, weekShareText } from "../wake/decide.js";
/** The one value `inbox add --wake` takes (T1147): wake each receiver as soon as its tab's wake check may. */
export const WAKE_NOW = 'now';
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
/**
 * Why the sender may not wake these receivers; undefined when it may. A wake spends the receiver's turn and its
 * team's budget line, so a group (`all`, `leads`, `group:<leader>`, `team:<team>`, `tree:leads`) is woken only by a
 * leader, and a session of another team only by the lead of a team above that team; on its own team any session may
 * wake a session it names.
 */
export function wakeRefusal(sender, group, targets) {
    if (group && !sender.leader) {
        return `--wake now on a group is a leader's: ${sender.id} leads no one on ${sender.team}; post the line without --wake, and each receiver reads it at its next prompt`;
    }
    const outside = targets.filter((target) => target.team !== sender.team && !(sender.teamLead && sender.below.includes(target.team)));
    if (outside.length > 0) {
        return (`--wake now reaches another team only from the lead of a team above it, since a wake spends that team's budget line: ` +
            `${sender.team}/${sender.id} may not wake ${outside.map((target) => target.label).join(', ')}; post the line without --wake`);
    }
    return undefined;
}
/**
 * `within about 3 minutes`: an ask wakes its receiver once the oldest ask is `wake.batchSeconds` old
 * (src/wake/asks.ts), at the first tick of its tab's wake hand after that, so the slowest team of the receivers sets it.
 */
function withinText(wakes) {
    const batchMs = Math.max(...wakes.map((wake) => wake.batchSeconds)) * SECOND_MS;
    const minutes = Math.max(1, Math.ceil((batchMs + WAKE_TICK_MS) / MINUTE_MS));
    return `within about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
/** `app's budget line`, or `the budget lines of app, web`, each team once. */
function budgetLinesText(wakes) {
    const teams = [...new Set(wakes.map((wake) => wake.team))];
    return teams.length === 1 ? `${teams.join('')}'s budget line` : `the budget lines of ${teams.join(', ')}`;
}
/** `about 81k W (2 warm cache, 1 cold), 0.07% of the week`: the share only when every wake's share is known. */
function sumText(wakes) {
    const cold = wakes.filter((wake) => wake.cost.cold).length;
    const parts = [...(cold < wakes.length ? [`${wakes.length - cold} warm cache`] : []), ...(cold > 0 ? [`${cold} cold`] : [])];
    const shares = wakes.map((wake) => wake.cost.weekPct);
    const week = shares.every((share) => share !== undefined) ? weekShareText(shares.reduce((sum, share) => sum + share, 0)) : '';
    return `about ${formatW(wakes.reduce((sum, wake) => sum + wake.cost.w, 0))} W (${parts.join(', ')})${week}`;
}
/**
 * What `--wake now` asked, after the POSTED line: who it wakes, at most, since a busy tab is not woken, what that
 * costs and whose budget line pays. `off` names the receivers whose team turned wakes off (`wake.enabled` false):
 * their line is posted and wakes no one.
 */
export function wakesLine(wakes, off) {
    const offText = off.length === 0 ? '' : `; wake.enabled is false on the team of ${off.join(', ')}, so ${off.length === 1 ? 'its line wakes' : 'their lines wake'} no one`;
    const [only] = wakes;
    if (only === undefined) {
        return `WAKES no one: wake.enabled is false on the team of ${off.join(', ')}`;
    }
    if (wakes.length === 1) {
        return `WAKES ${only.label} if its tab is idle, ${withinText(wakes)}: ${costText(only.cost)}, on ${budgetLinesText(wakes)}${offText}`;
    }
    return `WAKES at most ${wakes.length} sessions, those whose tab is idle, ${withinText(wakes)}: ${sumText(wakes)}, on ${budgetLinesText(wakes)}${offText}`;
}

import { quietSpanOf } from "../budget/warn.js";
import { isDefaultModel } from "../config/launch.js";
import { describeNameClash, describeTreeProblem } from "../config/tree.js";
import { ENV } from "../core/home.js";
import { isReservedName, RESERVED_RULE } from "../core/ids.js";
import { MS_PER_DAY, MS_PER_MINUTE, utcMinuteOf } from "../core/time.js";
import { unreadSince } from "../inbox/inbox.js";
import { wideAllowText } from "../permissions/report.js";
import { describeRequirement } from "../requirements/requirements.js";
import { TEAM_RULES_MAX_CHARS } from "../rules/pack.js";
import { missingDenyLines, SECRET_DENY_LINES } from "./deny-lines.js";
/**
 * Days an inbox may wait with unread lines and no read before doctor flags it. Hard-coded for now;
 * a candidate config key if teams want it tighter or looser.
 */
export const UNREAD_INBOX_DAYS = 7;
function plural(count, one, many) {
    return count === 1 ? one : many;
}
/**
 * Names that find the wrong session, or none: a removed session's (not a retired one's), a shared current one, a
 * former one taken over, a current one no message reaches.
 */
function nameFindings(input) {
    const { roster, command, retired } = input;
    const findings = [];
    const gone = new Map();
    const shared = new Set();
    for (const [name, holder] of roster.allNames()) {
        if (!roster.ids.includes(holder)) {
            if (!retired.has(holder)) {
                gone.set(holder, [...(gone.get(holder) ?? []), name]);
            }
            continue;
        }
        const current = roster.idsCalled(name);
        if (current.length > 1) {
            shared.add(name);
        }
        else if (current.length === 1 && !current.includes(holder)) {
            findings.push({ kind: 'name-shared', detail: `${name} was a name of ${holder} but is now the name of ${current.join(', ')}, so it no longer finds ${holder}` });
        }
    }
    for (const name of shared) {
        const ids = roster.idsCalled(name).join(', ');
        findings.push({ kind: 'name-shared', detail: `${name} is the name of ${ids}, so commands refuse it: give each its own with \`${command} rename\`` });
    }
    for (const [id, names] of gone) {
        const these = plural(names.length, 'was a name', 'were names');
        findings.push({ kind: 'name-gone', detail: `${names.join(', ')} ${these} of ${id}, which is no longer on the team: commands refuse them, filters read them as ${id}` });
    }
    for (const id of roster.ids) {
        const name = roster.nameOf(id);
        if (name !== undefined && isReservedName(name)) {
            findings.push({ kind: 'name-reserved', detail: `${name} (session ${id}) ${RESERVED_RULE}: give the tab another name with /rename, then record it with \`${command} rename ${id} <name>\`` });
        }
    }
    return findings;
}
/** A config name the rename log never gave the session: someone edited the config to rename it, and the log wins. */
function configFindings(input) {
    const { roster, renameLog, command } = input;
    return Object.entries(input.configNames).flatMap(([id, configured]) => {
        const current = roster.nameOf(id);
        const logged = renameLog.renames.some((rename) => rename.id === id && (rename.from === configured || rename.to === configured));
        if (current === undefined || current === configured || logged) {
            return [];
        }
        const detail = `the config names ${id} "${configured}", but the rename log calls it ${current} and the log wins: to rename it, run \`${command} rename ${id} ${configured}\``;
        return [{ kind: 'name-config', detail }];
    });
}
function renameLogFindings(input) {
    const { path, unreadable, newer } = input.renameLog;
    const findings = [];
    if (unreadable > 0) {
        findings.push({ kind: 'rename-log', detail: `${path} has ${unreadable} damaged line(s), skipped: the names they record do not resolve until fixed` });
    }
    if (newer > 0) {
        findings.push({ kind: 'rename-log', detail: `${path} has ${newer} line(s) from a newer ${input.command}, skipped: no rename can be recorded until ${input.command} is updated` });
    }
    return findings;
}
/** When an inbox started waiting: its last read, else its first unread line; undefined when neither is known. */
function waitingSince(unread) {
    if (unread.mark !== null) {
        return new Date(unread.mark.at);
    }
    return unreadSince(unread);
}
/** Inboxes nobody reads: one keyed by no session id on the team (nor a retired one's), or unread lines with no read for days. */
function inboxFindings(input) {
    const { roster, now, retired, zone } = input;
    return input.inboxes.flatMap((unread) => {
        const { area, mark } = unread;
        const count = unread.lines.length;
        if (retired.has(area)) {
            return [];
        }
        if (!roster.ids.includes(area)) {
            const found = roster.lookup(area);
            const hint = found.ok ? `; ${area} is a name of ${found.id}, whose inbox is keyed by its id` : '';
            const detail = `inbox ${area} (${count} unread) is no session's: inboxes are keyed by session id, so nobody reads it${hint}; nothing moves its lines`;
            return [{ kind: 'inbox-orphan', detail }];
        }
        const since = waitingSince(unread);
        if (count === 0 || (since !== undefined && now.getTime() - since.getTime() <= UNREAD_INBOX_DAYS * MS_PER_DAY)) {
            return [];
        }
        const read = mark === null ? 'has never read it' : `last read it ${zone.shortMinute(new Date(mark.at))}`;
        return [{ kind: 'inbox-unread', detail: `${area} has ${count} unread line(s) and ${read}: over ${UNREAD_INBOX_DAYS} days with no read` }];
    });
}
/**
 * Each team rules file a session gets only a pointer to, as `renderSessionContext` shares TEAM_RULES_MAX_CHARS: in
 * order, a file is shown while it fits beside the files shown before it, so a file that fits alone is named with them.
 */
function rulesFindings(input) {
    const shown = [];
    let used = 0;
    const findings = [];
    for (const rules of input.teamRules) {
        if (rules.chars === 0) {
            continue;
        }
        if (used + rules.chars <= TEAM_RULES_MAX_CHARS) {
            shown.push(rules.path);
            used += rules.chars;
            continue;
        }
        const detail = rules.chars > TEAM_RULES_MAX_CHARS
            ? `${rules.path} is ${rules.chars} characters, more than the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten it to keep it in every session's context`
            : `${rules.path} is ${rules.chars} characters, but the team rules shown before it (${shown.join(', ')}) take ${used} of the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten one of them`;
        findings.push({ kind: 'rules-long', detail });
    }
    return findings;
}
function count(value) {
    return value.toLocaleString('en-US');
}
/** At about 4 characters a token, rounded to the hundred: enough to weigh a cut. */
function tokensOf(chars) {
    return `~${count(Math.round(chars / 400) * 100)} tokens`;
}
function sizeFinding(what, chars, budget, key, fix) {
    if (chars <= budget) {
        return [];
    }
    const detail = `${what}: ${count(chars)} characters (${tokensOf(chars)}), over its budget of ${count(budget)} [contextFiles.${key}]; every call re-reads this text, so ${fix}`;
    return [{ kind: 'context-size', detail, budget: key }];
}
function contextFindings({ contextFiles: { read, budgets } }) {
    const claudeMdChars = read.claudeMd.reduce((sum, file) => sum + file.chars, 0);
    const claudeMd = read.claudeMd.map((file) => `${file.path} ${count(file.chars)}`).join(', ');
    const memory = read.memoryIndex;
    const skills = `skill listing (${read.skills.count} skills in ${read.skills.folders.join(', ')})`;
    return [
        ...sizeFinding(`CLAUDE.md files (${claudeMd})`, claudeMdChars, budgets.maxClaudeMdChars, 'maxClaudeMdChars', 'move how-tos into skills and facts into memory files'),
        ...(memory === undefined
            ? []
            : sizeFinding(`memory index ${memory.path}`, memory.chars, budgets.maxMemoryIndexChars, 'maxMemoryIndexChars', 'keep one short line per memory and its detail in the memory file')),
        ...sizeFinding(skills, read.skills.chars, budgets.maxSkillListingChars, 'maxSkillListingChars', 'shorten descriptions or merge skills'),
    ];
}
const SESSION_LIST_LABELS = {
    skills: 'skills',
    tools: 'deferred tools',
    agents: 'agent types',
    instructions: 'MCP instructions',
};
/** The largest sources a list names; the rest are counted. */
const SESSION_LIST_TOP_SOURCES = 3;
function describeSessionList(list) {
    const top = list.sources.slice(0, SESSION_LIST_TOP_SOURCES).map((source) => `${source.name} ${count(source.chars)}`);
    const rest = list.sources.length - top.length;
    const sources = rest > 0 ? [...top, `+${rest} more`] : top;
    const breakdown = sources.length === 0 ? '' : ` (${sources.join(', ')})`;
    return `${SESSION_LIST_LABELS[list.kind]} ${list.count}, ${count(list.chars)}${breakdown}`;
}
function sessionListsFinding({ sessionLists, contextFiles: { budgets } }) {
    if (sessionLists === undefined) {
        return [];
    }
    const lists = sessionLists.lists.filter((list) => list.count > 0);
    const chars = lists.reduce((sum, list) => sum + list.chars, 0);
    const budget = budgets.maxSessionListsChars;
    if (chars <= budget) {
        return [];
    }
    const detail = `lists in the context of the newest session (${sessionLists.transcript}): ${count(chars)} characters (${tokensOf(chars)}), ` +
        `over its budget of ${count(budget)} [contextFiles.maxSessionListsChars]: ${lists.map(describeSessionList).join('; ')}; ` +
        'every call re-reads this text, so turn off unused claude.ai connectors and skills in claude.ai settings, and unused plugins with /plugin';
    return [{ kind: 'context-lists', detail, budget: 'maxSessionListsChars' }];
}
/**
 * The `context-size` and `context-lists` findings: text every call of a session on this machine re-reads, over its
 * `contextFiles` budget. That text is no one area's, so `check` prints them as warnings no session owns, which go to
 * the lead (src/cli/unowned.ts, T951), not only in `doctor`.
 */
export function contextSizeFindings(input) {
    return [...contextFindings(input), ...sessionListsFinding(input)];
}
function treeFindings({ tree, command }) {
    return [
        ...tree.problems.map((problem) => ({ kind: problem.kind, detail: describeTreeProblem(problem, command) })),
        ...tree.clashes.map((clash) => ({ kind: 'name-two-teams', detail: describeNameClash(clash, command) })),
    ];
}
const ROUTING_OVERRIDES = [
    {
        kind: 'effort-env',
        name: ENV.effortLevel,
        effect: (value) => `it beats every --effort (the team config's launch efforts among them), /effort and per-call Agent effort, so a session or helper that gets it runs at ${value} whatever it was given`,
    },
    {
        kind: 'model-env',
        name: ENV.subagentModelForce,
        effect: () => 'set to 1 it beats every per-call Agent model, so a helper that gets it never runs on the model its caller gives it',
    },
];
/**
 * A variable set in doctor's own environment or in a settings file's `env` block that overrides every effort or
 * helper model a session or its caller picks, and a settings file whose block could not be read. Only the
 * overriding variables' values are printed.
 */
function routingEnvFindings({ env, settingsEnv }) {
    const sources = [
        { where: 'the environment doctor runs in', env },
        ...settingsEnv.flatMap((settings) => (settings.kind === 'env' ? [{ where: `the env block of ${settings.path}`, env: settings.env }] : [])),
    ];
    const overrides = ROUTING_OVERRIDES.flatMap(({ kind, name, effect }) => sources.flatMap(({ where, env: set }) => {
        const value = set[name]?.trim();
        return value ? [{ kind, detail: `${name}=${value} is set in ${where}: ${effect(value)}; unset it there to let each choose its own` }] : [];
    }));
    const names = ROUTING_OVERRIDES.map(({ name }) => name).join(' or ');
    const unreadable = settingsEnv.flatMap((settings) => settings.kind === 'unreadable' ? [{ kind: 'settings-json', detail: `${settings.path} is not a JSON object, so doctor could not check its env block for ${names}` }] : []);
    return [...overrides, ...unreadable];
}
/** A session whose launch names a model but no effort: it starts at that model's default effort, whatever the team meant. */
function launchFindings({ launches, roster }) {
    return launches.flatMap(({ id, launch }) => {
        if (isDefaultModel(launch.model) || launch.effort !== undefined) {
            return [];
        }
        const name = roster.nameOf(id) ?? id;
        const detail = `${name} (session ${id}) launches on model ${launch.model} with no effort, so it runs at that model's default effort (medium on Opus, Sonnet and Haiku 5.5): set launch.${id}.effort in the team config`;
        return [{ kind: 'launch-effort', detail }];
    });
}
/** One finding while any settings file holds a wide allow rule off the keep-list, counted by class, never its text; `check` shows it the lead too. */
export function allowFindings(wide) {
    const detail = wideAllowText(wide);
    return detail === undefined ? [] : [{ kind: 'allow-wide', detail }];
}
/**
 * One finding while a secret deny line is in no settings file a session reads, with the missing lines as a JSON list to
 * paste; `check` shows it the lead too. A file that is not a JSON object counts as holding none, and is named.
 */
export function denyFindings({ files, pasteInto }) {
    const missing = missingDenyLines(files);
    if (missing.length === 0) {
        return [];
    }
    const read = files.flatMap((settings) => (settings.kind === 'deny' ? [settings.path] : []));
    const unreadable = files.flatMap((settings) => (settings.kind === 'unreadable' ? [settings.path] : []));
    const where = read.length === 0 ? 'no settings file exists' : `read: ${read.join(', ')}`;
    const skipped = unreadable.length === 0 ? '' : `; ${unreadable.join(', ')} ${plural(unreadable.length, 'is', 'are')} not a JSON object, so its deny lines went unread`;
    const detail = `${missing.length} of ${SECRET_DENY_LINES.length} secret deny line(s) are in no settings file a session reads (${where}${skipped}), ` +
        "so a hook's allow or auto mode can approve reading a credential file or printing the environment; a deny line beats both, and teamrig never writes permissions: " +
        `paste these into the permissions.deny list of ${pasteInto} yourself: ${JSON.stringify(missing)}`;
    return [{ kind: 'deny-missing', detail }];
}
/** A configured project folder that is a file or nothing: `launch` refuses a tab's folder that is no folder (src/cli/commands/open.ts). */
function projectFindings({ projects, roster, command }) {
    return projects.flatMap(({ session, path, kind }) => {
        if (kind === 'folder') {
            return [];
        }
        const key = session === undefined ? 'team.project' : `launch.${session}.project`;
        const who = session === undefined ? 'a session without its own folder' : `${roster.nameOf(session) ?? session} (session ${session})`;
        const what = kind === 'file' ? 'a file' : 'missing';
        const detail = `${key} names ${path}, which is ${what} on this machine, so a tab ${command} open starts for ${who} refuses to launch: create the folder or fix ${key} in the team config`;
        return [{ kind: 'project-missing', detail }];
    });
}
/**
 * A PowerShell history file no profile gates: PSReadLine saves each typed line to it, a credential in a URL too, where
 * any local process can read it. The fix is the user's own, as Claude Code refuses an agent's write to a profile.
 */
function shellHistoryFindings({ shellHistory: { history, profiles, gated } }) {
    if (history === undefined || gated) {
        return [];
    }
    const read = profiles.length === 0 ? 'none of the usual profile paths exists' : `profiles read: ${profiles.join(', ')}`;
    const detail = `PowerShell keeps each line typed in its console in ${history}, a credential in a URL too, and no profile sets -AddToHistoryHandler or -HistorySaveStyle SaveNothing (${read}): ` +
        "add the history handler from the teamrig guide (workflows: Use a secret by reference) to your profile ($PROFILE) yourself; Claude Code refuses an agent's write to it";
    return [{ kind: 'shell-history', detail }];
}
/** A page webhook that resolves to no URL: the page goes out only on a login expiry, so a broken one shows nowhere else. */
function pageFindings({ page, command }) {
    if (page === undefined) {
        return [];
    }
    const detail = `team ${page.team}'s alerts.${page.key} gives no page URL (${page.problem}), so an expired Claude login pages nobody: ` +
        `fix alerts.${page.key} or what it names, then run ${command} page test`;
    return [{ kind: 'page-webhook', detail }];
}
/**
 * Quiet hours whose action is `ask`: in them a helper launch raises a permission prompt (`helperGate`), which nobody
 * at the host answers at night, so the tab waits until someone does (T1983: 222 minutes on 11-04). `block` refuses
 * the launch with its reason and the tab goes on. The budget off lets every launch go, and quiet hours of no length
 * never start, so neither asks.
 */
function quietHoursFindings({ budget, now, zone }) {
    const quiet = budget.quietHours;
    const start = quiet === undefined ? undefined : utcMinuteOf(quiet.startUtc);
    if (!budget.enabled || quiet === undefined || quiet.action !== 'ask' || start === undefined) {
        return [];
    }
    const dayStart = now.getTime() - (now.getTime() % MS_PER_DAY);
    const span = quietSpanOf(quiet, dayStart + start * MS_PER_MINUTE);
    if (span === undefined) {
        return [];
    }
    const detail = `budget.quietHours.action is ask, so in the quiet hours (${zone.clockSpan(new Date(span.from), new Date(span.to))}) a helper launch waits on a permission prompt ` +
        'nobody at the host answers, and its tab stalls until someone does: set budget.quietHours.action to block, which refuses the launch with its reason and lets the tab go on';
    return [{ kind: 'quiet-ask', detail }];
}
/**
 * The team's health checks: names that find the wrong session or none, a damaged rename log,
 * inboxes nobody reads, rules too long to show, text every call re-reads over its budget (files, and the lists the newest
 * session holds), a broken tree of teams or a session name two teams use, a variable that overrides every model or effort
 * choice, a launch with a model but no effort, local allow rules that approve a whole tool or program or hold a credential,
 * quiet hours that ask before a helper launch nobody answers at night, secret deny lines no settings file holds, a configured project folder that is no folder here, a PowerShell history no profile keeps credentials out of, and a page webhook that gives no URL.
 * It reads only; every fix is the user's.
 */
export function doctorFindings(input) {
    return [
        ...input.requirements.map((problem) => ({ kind: 'requirement', detail: describeRequirement(problem, input.command) })),
        ...nameFindings(input),
        ...configFindings(input),
        ...renameLogFindings(input),
        ...inboxFindings(input),
        ...rulesFindings(input),
        ...contextSizeFindings(input),
        ...treeFindings(input),
        ...routingEnvFindings(input),
        ...launchFindings(input),
        ...allowFindings(input.wideAllow),
        ...quietHoursFindings(input),
        ...denyFindings(input.settingsDeny),
        ...projectFindings(input),
        ...shellHistoryFindings(input),
        ...pageFindings(input),
    ];
}
export function formatFinding(finding) {
    return `WARN ${finding.kind} ${finding.detail}`;
}

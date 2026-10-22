import { isAbsolute, resolve } from 'node:path';
import { writeConfigWithBackup } from "../../config/load.js";
import { CONFIG_LIMITS, RULE_CONFLICT_LIMITS } from "../../config/limits.js";
import { CONFLICT_WINNERS, isConflictWinner } from "../../config/types.js";
import { clipEnd } from "../../core/clip.js";
import { claudeConfigDir, KIT_NAME } from "../../core/home.js";
import { expandHome, homeRelative, pathKey } from "../../core/paths.js";
import { SecretScanner } from "../../core/secrets.js";
import { CORE_RULE_KEYS, coreRuleKeyOf, ruleLabel } from "../../rules/keys.js";
import { isPlaceKind, PLACE_KINDS } from "../../rules/places.js";
import { ruleLinesOf, scanRules } from "../../rules/scan.js";
import { noPositionals, onePositional, requiredFlag, UsageError } from "../args.js";
import { callerOf } from "../inputs.js";
import { checkedNextConfig, configFileJson, openTeamKit, projectFolder, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
/**
 * `rules scan`, `rules keep` and `rules forget`: the local rules that can override a core rule, and the ones the user
 * chose to keep [ruleConflicts]. The CLI does the mechanical part: it finds every place such a rule lives, lists the
 * lines whose words touch a core rule's topic, and records what the user decided. Whether a line really conflicts is
 * semantic, so the model judges each candidate and talks it through with the user (the team-setup skill's step).
 */
/** The backup name of a config before `rules keep` or `rules forget` changed it. */
export const RULES_BACKUP_NAME = 'config.rules';
/** Above this many candidate lines, `rules scan` without --kind gives only the counts, so the list is judged a kind at a time. */
export const SCAN_LIST_MAX = 150;
/** A candidate's text prints up to this many characters. */
const CANDIDATE_TEXT_MAX_CHARS = 240;
/** A recorded rule's quote prints up to this many characters. */
const QUOTE_MAX_CHARS = 80;
function kindFlag(args) {
    const text = args.flags.get('kind');
    if (text !== undefined && !isPlaceKind(text)) {
        throw new UsageError(`--kind "${text}" is not one of ${PLACE_KINDS.join(', ')}`);
    }
    return text;
}
function ruleFlag(args) {
    const text = requiredFlag(args.flags, 'rule');
    const key = coreRuleKeyOf(text);
    if (key === undefined) {
        throw new UsageError(`--rule "${text}" is not a core rule's number (1-${CORE_RULE_KEYS.length}) or key (${CORE_RULE_KEYS.join(', ')})`);
    }
    return key;
}
function winsFlag(args) {
    const text = requiredFlag(args.flags, 'wins');
    if (!isConflictWinner(text)) {
        throw new UsageError(`--wins "${text}" is not one of ${CONFLICT_WINNERS.join(', ')}`);
    }
    return text;
}
/** `<path>:<line>`, split at the last colon so a Windows drive letter stays in the path. */
export function lineRefOf(text) {
    const at = text.lastIndexOf(':');
    const line = text.slice(at + 1);
    if (at <= 0 || !/^[1-9]\d*$/.test(line)) {
        throw new UsageError(`"${text}" is not <path>:<line>, e.g. ~/.claude/CLAUDE.md:12`);
    }
    return { path: text.slice(0, at), line: Number(line) };
}
/** `wins over rule 16 worktrees` or `loses to rule 16 worktrees`. */
function verdictOf(conflict) {
    return `${conflict.wins === 'local' ? 'wins over' : 'loses to'} rule ${ruleLabel(conflict.rule)}`;
}
function quoteOf(conflict) {
    return `"${clipEnd(conflict.text, QUOTE_MAX_CHARS)}"`;
}
function recordedLine(index, { conflict, line }) {
    const number = index + 1;
    if (line === undefined) {
        return `GONE ${number} ${conflict.file} ${quoteOf(conflict)} (rule ${ruleLabel(conflict.rule)}): the line is no longer there; \`${KIT_NAME} rules forget ${number} --yes\` drops the record`;
    }
    return `RECORDED ${number} ${conflict.file}:${line} ${quoteOf(conflict)} ${verdictOf(conflict)}${conflict.reason === undefined ? '' : ` (${conflict.reason})`}`;
}
function candidateLine(candidate, userHome, scanner) {
    const { rules, tags } = candidate.topics;
    const topics = [rules.map(ruleLabel).join(', '), tags.join(', ')].filter((part) => part !== '').join('; ');
    const secret = scanner.find(candidate.text);
    const text = secret === undefined ? clipEnd(candidate.text, CANDIDATE_TEXT_MAX_CHARS) : `(withheld: looks like it holds a secret (${secret.description}))`;
    return `CANDIDATE ${homeRelative(candidate.place.path, userHome)}:${candidate.line} [${topics}] ${text}`;
}
/**
 * `rules scan [--kind <kind>]`: every place a local rule can override a core rule, the recorded rules and where their
 * lines are now, and the candidate lines for the model to judge. It only reads; a secret-shaped line prints withheld.
 */
export async function scan(args, runtime) {
    noPositionals(args);
    const kind = kindFlag(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const project = await projectFolder(runtime);
    const found = await scanRules(runtime.files, runtime.probe, { claudeDir: claudeConfigDir(runtime.env, runtime.userHome), userHome: runtime.userHome, project, skills: kit.paths.skills, teamRules: kit.paths.teamRules }, config.ruleConflicts);
    const kinds = kind === undefined ? PLACE_KINDS : [kind];
    for (const each of kinds) {
        const places = found.places.filter((place) => place.kind === each).length;
        const candidates = found.candidates.filter((candidate) => candidate.place.kind === each).length;
        runtime.out.stdout(`SCANNED ${each}: ${places} place(s), ${candidates} candidate line(s)`);
    }
    if (found.nestedCapped) {
        runtime.out.stdout(`NOTE the search for CLAUDE.md files below ${project} stopped at its folder cap, so a deeper one is not listed`);
    }
    found.recorded.forEach((recorded, index) => runtime.out.stdout(recordedLine(index, recorded)));
    const listed = found.candidates.filter((candidate) => kinds.includes(candidate.place.kind));
    if (kind === undefined && listed.length > SCAN_LIST_MAX) {
        runtime.out.stdout(`NEXT ${listed.length} candidate lines are too many to judge in one read: list them a kind at a time with \`${KIT_NAME} rules scan --kind <kind>\``);
        return EXIT.ok;
    }
    const scanner = new SecretScanner(config.register.secretPatterns);
    listed.forEach((candidate) => runtime.out.stdout(candidateLine(candidate, runtime.userHome, scanner)));
    if (listed.length === 0) {
        runtime.out.stdout(found.recorded.length === 0 ? 'NONE no line here touches a core rule' : 'NONE no other line here touches a core rule');
    }
    else {
        runtime.out.stdout(`NEXT judge each candidate against the core rule it names; a line that tells a session to do otherwise conflicts. Show the user each conflict with what its rule asks in plain words, never the rule number alone. Record a line the user keeps with \`${KIT_NAME} rules keep <path>:<line> --rule <n> --wins local|teamrig --yes\``);
    }
    return EXIT.ok;
}
/** The team's kit and config, for a write only the lead makes. */
async function leadConfig(args, runtime, what) {
    const caller = callerOf(args.flags, runtime.env);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const roster = await rosterOf(runtime, kit, config);
    const lead = roster.holderOf('lead');
    if (sessionIdOf(roster, caller) !== lead) {
        throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${roster.nameOf(lead) ?? lead})`} ${what}`);
    }
    return { kit, config };
}
/**
 * Writes the next recorded rules with --yes, keeping the old config first, and says what it did; without --yes it
 * checks the next config and writes nothing.
 */
async function saveConflicts(args, runtime, kit, conflicts, what, done) {
    const json = { ...(await configFileJson(runtime, kit.load.path)), ruleConflicts: conflicts };
    checkedNextConfig(json);
    if (!args.switches.has('yes')) {
        runtime.out.stdout(`PREVIEW ${what}; nothing written (add --yes to write)`);
        return;
    }
    const backup = await writeConfigWithBackup(runtime.files, { configPath: kit.load.path, backupsDir: kit.paths.backups, backupName: RULES_BACKUP_NAME }, json, runtime.clock);
    runtime.out.stdout(`${done}; the old config is at ${backup}`);
}
/**
 * `rules keep <path>:<line> --rule <n|key> --wins local|teamrig [--reason "<why>"] [--yes]`: the lead records a local
 * rule the user keeps although it conflicts with a core rule. `--wins local` makes it an exception the core rules
 * name; `--wins teamrig` keeps the text but has the core rule win, with a warning that a session may still follow it.
 * The record quotes the line's start, so the line is found again when the lines above it move.
 */
export async function keep(args, runtime) {
    const { path, line } = lineRefOf(onePositional(args, 'path:line'));
    const rule = ruleFlag(args);
    const wins = winsFlag(args);
    const reason = args.flags.get('reason')?.trim();
    const { kit, config } = await leadConfig(args, runtime, "records the team's kept local rules");
    const expanded = expandHome(path, runtime.userHome);
    const absolute = isAbsolute(expanded) ? expanded : resolve(runtime.cwd, expanded);
    const file = homeRelative(absolute, runtime.userHome);
    const raw = await runtime.files.read(absolute);
    if (raw === undefined) {
        throw new RefusedError(`${file} does not exist`);
    }
    const found = ruleLinesOf(absolute, raw).find((entry) => entry.line === line);
    if (found === undefined || found.text === '') {
        throw new RefusedError(`${file} has no rule at line ${line}${absolute.toLowerCase().endsWith('.json') ? ' (a settings file is read for its autoMode lines only)' : ''}`);
    }
    const refusal = new SecretScanner(config.register.secretPatterns).refusal(`${file}:${line}`, found.text);
    if (refusal !== undefined) {
        throw new RefusedError(refusal);
    }
    const record = {
        file,
        text: found.text.slice(0, RULE_CONFLICT_LIMITS.textMaxLength).trimEnd(),
        rule,
        wins,
        ...(reason === undefined || reason === '' ? {} : { reason }),
    };
    const conflicts = config.ruleConflicts;
    const same = conflicts.findIndex((conflict) => pathKey(expandHome(conflict.file, runtime.userHome)) === pathKey(absolute) && conflict.text === record.text && conflict.rule === rule);
    const label = `${file}:${line} ${quoteOf(record)} ${verdictOf(record)}`;
    const kept = same === -1 ? undefined : conflicts[same];
    if (kept !== undefined && kept.wins === record.wins && kept.reason === record.reason) {
        runtime.out.stdout(`UNCHANGED ${same + 1} ${label}: already recorded this way`);
        return EXIT.ok;
    }
    if (kept === undefined && conflicts.length >= CONFIG_LIMITS.ruleConflicts.maxItems) {
        throw new RefusedError(`the team keeps at most ${CONFIG_LIMITS.ruleConflicts.maxItems} local rules; drop one first (\`${KIT_NAME} rules scan\` numbers them for \`${KIT_NAME} rules forget <n>\`)`);
    }
    const next = kept === undefined ? [...conflicts, record] : conflicts.map((conflict, index) => (index === same ? record : conflict));
    const number = kept === undefined ? next.length : same + 1;
    await saveConflicts(args, runtime, kit, next, `keep ${label}`, `KEPT ${number} ${label}`);
    if (wins === 'teamrig') {
        runtime.out.stdout(`WARN the line stays and rule ${ruleLabel(rule)} wins over it, but a session still reads the line and may follow it: removing or rewriting it is safer`);
    }
    runtime.out.stdout('NEXT sessions read the kept rules in the team rules from their next start or refresh');
    return EXIT.ok;
}
/** `rules forget <n> [--yes]`: the lead drops recorded rule n, as `rules scan` numbers them; the line itself is left alone. */
export async function forget(args, runtime) {
    const text = onePositional(args, 'n');
    const { kit, config } = await leadConfig(args, runtime, "drops the team's kept local rules");
    const conflicts = config.ruleConflicts;
    const number = /^[1-9]\d*$/.test(text) ? Number(text) : 0;
    const dropped = conflicts[number - 1];
    if (dropped === undefined) {
        throw new UsageError(`"${text}" is not a kept rule's number: the team has ${conflicts.length}, and \`${KIT_NAME} rules scan\` numbers them`);
    }
    const label = `${number} ${dropped.file} ${quoteOf(dropped)} (rule ${ruleLabel(dropped.rule)})`;
    await saveConflicts(args, runtime, kit, conflicts.filter((_, index) => index !== number - 1), `forget ${label}`, `FORGOT ${label}`);
    return EXIT.ok;
}

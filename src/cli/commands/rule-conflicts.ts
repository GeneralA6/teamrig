import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CONFIG_LIMITS, RULE_CONFLICT_LIMITS } from '../../config/limits.ts';
import { CONFLICT_WINNERS, isConflictWinner, type ConflictWinner, type KitConfig, type RuleConflict } from '../../config/types.ts';
import { clipEnd } from '../../core/clip.ts';
import type { JsonRecord } from '../../core/guards.ts';
import { claudeConfigDir, KIT_NAME } from '../../core/home.ts';
import { expandHome, homeRelative, pathKey } from '../../core/paths.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { CORE_RULE_KEYS, coreRuleKeyOf, ruleLabel, type CoreRuleKey } from '../../rules/keys.ts';
import { isPlaceKind, PLACE_KINDS, type PlaceKind } from '../../rules/places.ts';
import { coreRuleTexts, type KeptRule } from '../../rules/pack.ts';
import { ruleLinesOf, scanRules, type Candidate, type RecordedConflict, type RuleScan } from '../../rules/scan.ts';
import { topicsLabel } from '../../rules/topics.ts';
import { isCleared, nextVerdicts, RULE_HASH_CLOCK, ruleHashesOf, verdictsByText, VerdictStore, type ClearedLine, type RuleHashes } from '../../rules/verdicts.ts';
import { lineHash } from '../../inbox/line-hash.ts';
import { formatUtcDay } from '../../core/time.ts';
import { noPositionals, onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { callerOf, listOf } from '../inputs.ts';
import { checkedNextConfig, configFileJson, configLockOf, leadOnly, openTeamKit, projectFolder, requireConfig, rosterOf, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { keptRulesAboveOf, teamRulesFilesOf } from '../team-rules.ts';
import { loadTree } from '../tree.ts';

/**
 * `rules scan`, `rules keep`, `rules forget` and `rules clear`: the local rules that can override a core rule, the ones
 * the user chose to keep [ruleConflicts], and the lines judged not to conflict (src/rules/verdicts.ts). The CLI does the
 * mechanical part: it finds every place such a rule lives, lists the lines whose words touch a core rule's topic, and
 * records what was decided. Whether a line really conflicts is semantic, so the model judges each candidate and talks
 * it through with the user (the team-setup skill's step).
 */

/** The backup name of a config before `rules keep` or `rules forget` changed it. */
export const RULES_BACKUP_NAME = 'config.rules';

/** Above this many candidate lines, `rules scan` without --kind gives only the counts, so the list is judged a kind at a time. */
export const SCAN_LIST_MAX = 150;

/** A candidate's text prints up to this many characters. */
const CANDIDATE_TEXT_MAX_CHARS = 240;
/** A recorded rule's quote prints up to this many characters. */
const QUOTE_MAX_CHARS = 80;

function kindFlag(args: ParsedArgs): PlaceKind | undefined {
  const text = args.flags.get('kind');
  if (text !== undefined && !isPlaceKind(text)) {
    throw new UsageError(`--kind "${text}" is not one of ${PLACE_KINDS.join(', ')}`);
  }
  return text;
}

function ruleFlag(args: ParsedArgs): CoreRuleKey {
  const text = requiredFlag(args.flags, 'rule');
  const key = coreRuleKeyOf(text);
  if (key === undefined) {
    throw new UsageError(`--rule "${text}" is not a core rule's number (1-${CORE_RULE_KEYS.length}) or key (${CORE_RULE_KEYS.join(', ')})`);
  }
  return key;
}

function winsFlag(args: ParsedArgs): ConflictWinner {
  const text = requiredFlag(args.flags, 'wins');
  if (!isConflictWinner(text)) {
    throw new UsageError(`--wins "${text}" is not one of ${CONFLICT_WINNERS.join(', ')}`);
  }
  return text;
}

/** `<path>:<line>`, split at the last colon so a Windows drive letter stays in the path. */
export function lineRefOf(text: string): { path: string; line: number } {
  const at = text.lastIndexOf(':');
  const line = text.slice(at + 1);
  if (at <= 0 || !/^[1-9]\d*$/.test(line)) {
    throw new UsageError(`"${text}" is not <path>:<line>, e.g. ~/.claude/CLAUDE.md:12`);
  }
  return { path: text.slice(0, at), line: Number(line) };
}

/** `wins over rule 16 worktrees` or `loses to rule 16 worktrees`. */
function verdictOf(conflict: RuleConflict): string {
  return `${conflict.wins === 'local' ? 'wins over' : 'loses to'} rule ${ruleLabel(conflict.rule)}`;
}

function quoteOf(conflict: RuleConflict): string {
  return `"${clipEnd(conflict.text, QUOTE_MAX_CHARS)}"`;
}

function recordedLine(index: number, { conflict, line }: RecordedConflict): string {
  const number = index + 1;
  if (line === undefined) {
    return `GONE ${number} ${conflict.file} ${quoteOf(conflict)} (rule ${ruleLabel(conflict.rule)}): the line is no longer there; \`${KIT_NAME} rules forget ${number} --yes\` drops the record`;
  }
  return `RECORDED ${number} ${conflict.file}:${line} ${quoteOf(conflict)} ${verdictOf(conflict)}${reasonOf(conflict)}`;
}

function reasonOf(conflict: RuleConflict): string {
  return conflict.reason === undefined ? '' : ` (${conflict.reason})`;
}

/** A rule a team above kept: it binds this team's sessions too, and only that team's lead records or drops it. */
function aboveLine(team: string, { conflict, line }: RecordedConflict): string {
  if (line === undefined) {
    return `ABOVE ${team} GONE ${conflict.file} ${quoteOf(conflict)} (rule ${ruleLabel(conflict.rule)}): the line is no longer there; team ${team}'s lead drops the record`;
  }
  return `ABOVE ${team} ${conflict.file}:${line} ${quoteOf(conflict)} ${verdictOf(conflict)}${reasonOf(conflict)}`;
}

function candidateLine(candidate: Candidate, userHome: string, scanner: SecretScanner): string {
  const topics = topicsLabel(candidate.topics);
  const secret = scanner.find(candidate.text);
  const text = secret === undefined ? clipEnd(candidate.text, CANDIDATE_TEXT_MAX_CHARS) : `(withheld: looks like it holds a secret (${secret.description}))`;
  return `CANDIDATE ${homeRelative(candidate.place.path, userHome)}:${candidate.line} [${topics}] ${text}`;
}

/** What `rules scan` lists for its --kind and --all; `rules clear` reads the same, so it clears only what that scan showed. */
interface ScanView {
  readonly kind: PlaceKind | undefined;
  readonly all: boolean;
  readonly project: string;
  /** Its recorded conflicts: the team's own, in config order, then those of the teams above, root first, tagged. */
  readonly found: RuleScan<KeptRule>;
  readonly kinds: readonly PlaceKind[];
  /** The candidates of the listed kinds a stored verdict still clears; none with --all. */
  readonly cleared: readonly Candidate[];
  /** The candidates of the listed kinds left to judge: every one with --all. */
  readonly open: readonly Candidate[];
  readonly hashes: RuleHashes;
  readonly verdicts: readonly ClearedLine[];
}

async function scanView(runtime: CliRuntime, kit: Kit, config: KitConfig, kind: PlaceKind | undefined, all: boolean): Promise<ScanView> {
  const project = await projectFolder(runtime, config);
  const kitTree = await loadTree(runtime);
  const teamRules = teamRulesFilesOf(kit, kitTree).map((file) => file.path);
  const found = await scanRules<KeptRule>(
    runtime.files,
    runtime.probe,
    { claudeDir: claudeConfigDir(runtime.env, runtime.userHome), userHome: runtime.userHome, project, skills: kit.paths.skills, teamRules },
    [...config.ruleConflicts, ...keptRulesAboveOf(kit, kitTree)],
  );
  const kinds = kind === undefined ? PLACE_KINDS : [kind];
  const hashes = ruleHashesOf(coreRuleTexts(config, KIT_NAME, runtime.platform, RULE_HASH_CLOCK));
  const verdicts = await new VerdictStore(runtime.files, kit.paths.ruleVerdicts).read();
  const byText = verdictsByText(verdicts);
  const listed = found.candidates.filter((candidate) => kinds.includes(candidate.place.kind));
  const cleared = all ? [] : listed.filter((candidate) => isCleared(candidate, byText, hashes));
  const open = all ? listed : listed.filter((candidate) => !isCleared(candidate, byText, hashes));
  return { kind, all, project, found, kinds, cleared, open, hashes, verdicts };
}

/** True when the scan lists too many lines to judge in one read, so it gives only the counts. */
function isCapped(view: ScanView): boolean {
  return view.kind === undefined && view.open.length > SCAN_LIST_MAX;
}

/** ` --kind memory --all`: the scan's flags, for the command a NEXT or a refusal names. */
function scanFlags(view: ScanView): string {
  return `${view.kind === undefined ? '' : ` --kind ${view.kind}`}${view.all ? ' --all' : ''}`;
}

function candidateKey(path: string, line: number): string {
  return `${pathKey(path)}:${line}`;
}

/** The fingerprint of the lines a scan lists, which `rules clear --seen` names so it clears only lines that were read. */
function seenDigest(listed: readonly Candidate[]): string {
  return lineHash(listed.map((candidate) => `${candidateKey(candidate.place.path, candidate.line)} ${candidate.text}`).join('\n'));
}

/** A path as typed: `~` expanded, a relative one read from the working folder. */
function absoluteOf(path: string, runtime: CliRuntime): string {
  const expanded = expandHome(path, runtime.userHome);
  return isAbsolute(expanded) ? expanded : resolve(runtime.cwd, expanded);
}

/**
 * `rules scan [--kind <kind>] [--all]`: every place a local rule can override a core rule, the recorded rules and where
 * their lines are now (those a team above kept as ABOVE lines, then the team's own, numbered for `rules forget`), and
 * the candidate lines for the model to judge, leaving out the ones `rules clear` recorded as
 * not conflicting while their text and the core rules they touch are unchanged (--all lists those too). It only reads;
 * a secret-shaped line prints withheld.
 */
export async function scan(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kind = kindFlag(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const view = await scanView(runtime, kit, config, kind, args.switches.has('all'));
  const { found } = view;
  for (const each of view.kinds) {
    const places = found.places.filter((place) => place.kind === each).length;
    const open = view.open.filter((candidate) => candidate.place.kind === each).length;
    const cleared = view.cleared.filter((candidate) => candidate.place.kind === each).length;
    runtime.out.stdout(`SCANNED ${each}: ${places} place(s), ${open} candidate line(s)${cleared === 0 ? '' : `, ${cleared} more cleared before (--all lists them)`}`);
  }
  if (found.nestedCapped) {
    runtime.out.stdout(`NOTE the search for CLAUDE.md files below ${view.project} stopped at its folder cap, so a deeper one is not listed`);
  }
  for (const recorded of found.recorded) {
    if (recorded.conflict.team !== undefined) {
      runtime.out.stdout(aboveLine(recorded.conflict.team, recorded));
    }
  }
  found.recorded
    .filter((recorded) => recorded.conflict.team === undefined)
    .forEach((recorded, index) => runtime.out.stdout(recordedLine(index, recorded)));
  if (isCapped(view)) {
    runtime.out.stdout(`NEXT ${view.open.length} candidate lines are too many to judge in one read: list them a kind at a time with \`${KIT_NAME} rules scan --kind <kind>\``);
    return EXIT.ok;
  }
  const scanner = new SecretScanner(config.register.secretPatterns);
  view.open.forEach((candidate) => runtime.out.stdout(candidateLine(candidate, runtime.userHome, scanner)));
  if (view.open.length === 0) {
    runtime.out.stdout(found.recorded.length === 0 && view.cleared.length === 0 ? 'NONE no line here touches a core rule' : 'NONE no other line here touches a core rule');
  } else {
    runtime.out.stdout(
      `NEXT judge each candidate against the core rule it names; a line that tells a session to do otherwise conflicts. Show the user each conflict with what its rule asks in plain words, never the rule number alone. Record a line the user keeps with \`${KIT_NAME} rules keep <path>:<line> --rule <n> --wins local|teamrig --yes\``,
    );
    runtime.out.stdout(
      `NEXT then record the lines that do not conflict, so a rescan lists only new or changed ones: \`${KIT_NAME} rules clear${scanFlags(view)} --seen ${seenDigest(view.open)} [--except <path>:<line>,...] --yes\`, --except naming each line still to settle`,
    );
  }
  return EXIT.ok;
}

/** The team's kit and config, for a write only the lead makes. */
async function leadConfig(args: ParsedArgs, runtime: CliRuntime, what: string): Promise<{ kit: Kit; config: KitConfig }> {
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'write');
  const roster = await rosterOf(runtime, kit, config);
  leadOnly(roster, caller, what);
  return { kit, config };
}

/** A kept-rules change: the rules `config` read when it was planned, and the rules to write in their place. */
interface ConflictsChange {
  readonly config: KitConfig;
  readonly conflicts: readonly RuleConflict[];
}

/**
 * Writes the next recorded rules with --yes, keeping the old config first, and says what it did; without --yes it
 * checks the next config and writes nothing. Under the config lock it reads the file again, keeping a change other
 * keys took meanwhile (a hire), and refuses when the kept rules it was planned on changed meanwhile.
 */
async function saveConflicts(args: ParsedArgs, runtime: CliRuntime, kit: Kit, change: ConflictsChange, what: string, done: string): Promise<void> {
  await configLockOf(runtime, kit, change.config).run(async (writer) => {
    const current = await configFileJson(runtime, kit.load.path);
    if (!isDeepStrictEqual(checkedNextConfig(current).ruleConflicts, change.config.ruleConflicts)) {
      throw new RefusedError(`the team's kept local rules changed while this ran; run \`${KIT_NAME} rules\` again`);
    }
    const json: JsonRecord = { ...current, ruleConflicts: change.conflicts };
    checkedNextConfig(json);
    if (!args.switches.has('yes')) {
      runtime.out.stdout(`PREVIEW ${what}; nothing written (add --yes to write)`);
      return;
    }
    const backup = await writer.write(json, RULES_BACKUP_NAME);
    runtime.out.stdout(`${done}; the old config is at ${backup}`);
  });
}

/**
 * `rules keep <path>:<line> --rule <n|key> --wins local|teamrig [--reason "<why>"] [--yes]`: the lead records a local
 * rule the user keeps although it conflicts with a core rule. `--wins local` makes it an exception the core rules
 * name; `--wins teamrig` keeps the text but has the core rule win, with a warning that a session may still follow it.
 * The record quotes the line's start, so the line is found again when the lines above it move.
 */
export async function keep(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const { path, line } = lineRefOf(onePositional(args, 'path:line'));
  const rule = ruleFlag(args);
  const wins = winsFlag(args);
  const reason = args.flags.get('reason')?.trim();
  const { kit, config } = await leadConfig(args, runtime, "records the team's kept local rules");
  const absolute = absoluteOf(path, runtime);
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
  const record: RuleConflict = {
    file,
    text: found.text.slice(0, RULE_CONFLICT_LIMITS.textMaxLength).trimEnd(),
    rule,
    wins,
    ...(reason === undefined || reason === '' ? {} : { reason }),
  };
  const conflicts = config.ruleConflicts;
  const same = conflicts.findIndex(
    (conflict) => pathKey(expandHome(conflict.file, runtime.userHome)) === pathKey(absolute) && conflict.text === record.text && conflict.rule === rule,
  );
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
  await saveConflicts(args, runtime, kit, { config, conflicts: next }, `keep ${label}`, `KEPT ${number} ${label}`);
  if (wins === 'teamrig') {
    runtime.out.stdout(
      `WARN the line stays and rule ${ruleLabel(rule)} wins over it, but a session still reads the line and may follow it: removing or rewriting it is safer`,
    );
  }
  runtime.out.stdout('NEXT sessions read the kept rules in the team rules from their next start or refresh');
  return EXIT.ok;
}

/** The candidate keys --except names, each one a line the scan lists. */
function exceptedKeys(args: ParsedArgs, runtime: CliRuntime, listed: readonly Candidate[]): ReadonlySet<string> {
  const text = args.flags.get('except');
  if (text === undefined) {
    return new Set();
  }
  const keys = new Set(listed.map((candidate) => candidateKey(candidate.place.path, candidate.line)));
  return new Set(
    listOf('--except', text).map((ref) => {
      const { path, line } = lineRefOf(ref);
      const key = candidateKey(absoluteOf(path, runtime), line);
      if (!keys.has(key)) {
        throw new UsageError(`--except ${ref} is not a candidate line this scan lists`);
      }
      return key;
    }),
  );
}

/**
 * `rules clear [--kind <kind>] [--all] --seen <digest> [--except <path>:<line>,...] [--yes]`: the lead records the
 * candidate lines that scan listed, but those --except names, as not conflicting with a core rule, so a rescan leaves
 * them out while their text and the rules they touch stay the same. --seen is the digest the scan printed, so only
 * lines the model judged are cleared; a secret-shaped line, withheld from the model, is never cleared.
 */
export async function clear(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kind = kindFlag(args);
  const seen = requiredFlag(args.flags, 'seen');
  const { kit, config } = await leadConfig(args, runtime, 'records the rule lines that do not conflict');
  const view = await scanView(runtime, kit, config, kind, args.switches.has('all'));
  if (isCapped(view)) {
    throw new RefusedError(`${view.open.length} candidate lines are more than one read judges: scan and clear them a kind at a time with --kind <kind>`);
  }
  if (seen !== seenDigest(view.open)) {
    throw new RefusedError(`the candidate lines changed since that scan, so not all were judged: run \`${KIT_NAME} rules scan${scanFlags(view)}\` again`);
  }
  const except = exceptedKeys(args, runtime, view.open);
  const scanner = new SecretScanner(config.register.secretPatterns);
  const cleared: Candidate[] = [];
  for (const candidate of view.open) {
    const ref = `${homeRelative(candidate.place.path, runtime.userHome)}:${candidate.line}`;
    if (scanner.find(candidate.text) !== undefined) {
      runtime.out.stdout(`SKIPPED ${ref}: it looks like it holds a secret, so it was withheld and stays to settle by hand`);
    } else if (!except.has(candidateKey(candidate.place.path, candidate.line))) {
      cleared.push(candidate);
    }
  }
  if (cleared.length === 0) {
    runtime.out.stdout('NONE no listed line is left to clear');
    return EXIT.ok;
  }
  const what = `${cleared.length} line(s) as not conflicting${except.size === 0 ? '' : `, ${except.size} left listed`}`;
  if (!args.switches.has('yes')) {
    runtime.out.stdout(`PREVIEW clear ${what}; nothing written (add --yes to write)`);
    return EXIT.ok;
  }
  const day = formatUtcDay(new Date(runtime.clock.now()));
  await new VerdictStore(runtime.files, kit.paths.ruleVerdicts).write(nextVerdicts(view.verdicts, view.found.candidates, cleared, view.hashes, day));
  runtime.out.stdout(`CLEARED ${what}`);
  runtime.out.stdout(`NEXT \`${KIT_NAME} rules scan\` leaves them out until a line or a core rule it touches changes (--all lists them again)`);
  return EXIT.ok;
}

/** `rules forget <n> [--yes]`: the lead drops recorded rule n, as `rules scan` numbers them; the line itself is left alone. */
export async function forget(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const text = onePositional(args, 'n');
  const { kit, config } = await leadConfig(args, runtime, "drops the team's kept local rules");
  const conflicts = config.ruleConflicts;
  const number = /^[1-9]\d*$/.test(text) ? Number(text) : 0;
  const dropped = conflicts[number - 1];
  if (dropped === undefined) {
    throw new UsageError(`"${text}" is not a kept rule's number: the team has ${conflicts.length}, and \`${KIT_NAME} rules scan\` numbers them`);
  }
  const label = `${number} ${dropped.file} ${quoteOf(dropped)} (rule ${ruleLabel(dropped.rule)})`;
  await saveConflicts(
    args,
    runtime,
    kit,
    { config, conflicts: conflicts.filter((_, index) => index !== number - 1) },
    `forget ${label}`,
    `FORGOT ${label}`,
  );
  return EXIT.ok;
}

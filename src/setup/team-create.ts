import { join } from 'node:path';
import { formatConfig, loadConfig } from '../config/load.ts';
import type { ConfigFormat } from '../config/migrate.ts';
import { parseConfig } from '../config/parse.ts';
import { Roster } from '../config/roster.ts';
import { describeTreeProblem, teamNodeOf, type TeamNode, type TeamTree, type TreeProblem } from '../config/tree.ts';
import { CONFIG_VERSION } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { KIT_NAME } from '../core/home.ts';
import { ID_PATTERN, ID_RULE } from '../core/ids.ts';
import { resolveTeam, TEAM_POINTER } from '../core/team.ts';

/**
 * `teamrig team create`: a new team's config in the kit home and the pointer that ties a project
 * folder to it. Every check runs before anything is written, and a run that finds both already in
 * place succeeds without writing, so the command is safe to repeat. With `--parent` the new team
 * hangs under another team's lead; the tree it joins must stay within its limits.
 */

/** A new team: its id, its lead's session id, every session id with the lead first, and its parent team, if any. */
export interface TeamSpec {
  readonly team: string;
  readonly lead: string;
  readonly sessions: readonly string[];
  readonly parent: string | undefined;
}

/** A value, or why there is none, worded for the person who typed the command. */
export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

/** A file the setup writes, or one already in place that it leaves as it is. */
export type FileStep =
  | { readonly kind: 'create'; readonly path: string; readonly text: string }
  | { readonly kind: 'keep'; readonly path: string; readonly why: string };

export interface SetupPlan {
  readonly spec: TeamSpec;
  readonly config: FileStep;
  readonly pointer: FileStep;
  /** Whether the team's config, new or kept, turns tab status on. */
  readonly tabStatus: boolean;
}

/** The config's step, and whether that config turns tab status on. */
interface ConfigStep {
  readonly file: FileStep;
  readonly tabStatus: boolean;
}

/** A new team's tab status: on, as it shows only where Claude Code leaves the tab title to hooks. */
const NEW_TEAM_TAB_STATUS = { enabled: true } as const;

function ok<T>(value: T): Checked<T> {
  return { ok: true, value };
}

function fail<T>(problem: string): Checked<T> {
  return { ok: false, problem };
}

/** The team from the command line: ids only, no session twice, at least one session besides the lead, and not its own parent. */
export function teamSpecOf(team: string, sessionList: string, lead: string, parent?: string): Checked<TeamSpec> {
  if (!ID_PATTERN.test(team)) {
    return fail(`team "${team}" is not an id (${ID_RULE})`);
  }
  if (parent !== undefined && !ID_PATTERN.test(parent)) {
    return fail(`--parent "${parent}" is not a team id (${ID_RULE})`);
  }
  if (parent === team) {
    return fail(`--parent ${parent} is the team itself; a root team has no --parent`);
  }
  if (!ID_PATTERN.test(lead)) {
    return fail(`--lead "${lead}" is not a session id (${ID_RULE})`);
  }
  const listed = sessionList.split(',').map((id) => id.trim());
  const bad = listed.find((id) => !ID_PATTERN.test(id));
  if (bad !== undefined) {
    return fail(`--sessions "${bad}" is not a session id (${ID_RULE})`);
  }
  const twice = listed.find((id, index) => listed.indexOf(id) !== index);
  if (twice !== undefined) {
    return fail(`--sessions lists "${twice}" twice`);
  }
  // The lead may be listed too; it is always on the team.
  const workers = listed.filter((id) => id !== lead);
  if (workers.length === 0) {
    return fail('--sessions needs at least one session besides the lead');
  }
  return ok({ team, lead, sessions: [lead, ...workers], parent });
}

/** The smallest config that runs a team, with its place in a tree and tab status on: every other setting takes its default. */
export function configRecordOf(spec: TeamSpec): JsonRecord {
  const team: JsonRecord = spec.parent === undefined ? { id: spec.team } : { id: spec.team, parent: spec.parent };
  const record: JsonRecord = {
    configVersion: CONFIG_VERSION,
    team,
    sessions: [...spec.sessions],
    roles: { lead: spec.lead },
    tabStatus: { ...NEW_TEAM_TAB_STATUS },
  };
  const [issue] = parseConfig(record).issues;
  if (issue !== undefined) {
    throw new Error(`the new team config breaks its own schema at ${issue.path}: ${issue.message}`);
  }
  return record;
}

/** The new team as the tree will see it, its sessions under their default names. */
export function teamNodeOfSpec(spec: TeamSpec): TeamNode {
  const { config } = parseConfig(configRecordOf(spec));
  return teamNodeOf(spec.team, config, new Roster(config, spec.team));
}

function sameTeam(spec: TeamSpec, sessions: readonly string[], lead: string, parent: string | undefined): boolean {
  return lead === spec.lead && parent === spec.parent && sessions.length === spec.sessions.length && spec.sessions.every((id) => sessions.includes(id));
}

function parentText(parent: string | undefined): string {
  return parent === undefined ? 'no parent' : `parent ${parent}`;
}

async function configStep(files: Files, format: ConfigFormat, spec: TeamSpec, path: string): Promise<Checked<ConfigStep>> {
  const load = await loadConfig(files, path, format.migrations, format.version);
  switch (load.status) {
    case 'missing':
      return ok({ file: { kind: 'create', path, text: formatConfig(configRecordOf(spec)) }, tabStatus: NEW_TEAM_TAB_STATUS.enabled });
    case 'unreadable':
      return fail(`team ${spec.team} already has a config at ${path}, and it cannot be read (${load.issue.message}); choose another team name`);
    case 'loaded':
      break;
  }
  const { sessions, roles, team, tabStatus } = load.config;
  if (sameTeam(spec, sessions, roles.lead, team?.parent)) {
    return ok({ file: { kind: 'keep', path, why: `team ${spec.team} already has these sessions` }, tabStatus: tabStatus.enabled });
  }
  return fail(
    `team ${spec.team} already exists at ${path} with sessions ${sessions.join(', ')} (lead ${roles.lead}, ${parentText(team?.parent)}); choose another team name, or change that config by hand`,
  );
}

function problemKey(problem: TreeProblem): string {
  return JSON.stringify(problem);
}

/**
 * Whether the new team can join the tree: its parent has a config, and adding it breaks no tree rule
 * (depth, child teams, a loop) that was not already broken, nor gives a session a name another team uses.
 */
function treeStep(tree: TeamTree, spec: TeamSpec): Checked<TeamNode> {
  const node = teamNodeOfSpec(spec);
  if (spec.parent !== undefined && tree.node(spec.parent) === undefined) {
    return fail(`parent team ${spec.parent} has no config; create it first with ${KIT_NAME} team create ${spec.parent} --sessions <id,id>`);
  }
  const joined = tree.with(node);
  const before = new Set(tree.problems().map(problemKey));
  const added = joined.problems().find((problem) => !before.has(problemKey(problem)));
  if (added !== undefined) {
    return fail(`team ${spec.team} cannot join that tree: ${describeTreeProblem(added, KIT_NAME)}`);
  }
  const clash = joined.nameClashes().find((found) => found.holders.some((holder) => holder.team === spec.team));
  if (clash !== undefined) {
    const others = clash.holders
      .filter((holder) => holder.team !== spec.team)
      .map((holder) => `${holder.team}/${holder.id}`)
      .join(', ');
    return fail(
      `the session name ${clash.name} is already used by ${others}, and Claude Code session names are machine-wide; choose another team id, or rename ${others} with ${KIT_NAME} rename`,
    );
  }
  return ok(node);
}

/**
 * A project tied to no team gets a pointer; one tied to this team, here or by a parent folder, keeps
 * it, and so does one tied to another team of the same tree: a sub-team's sessions are opened as
 * `<team>/<id>`, and their team comes from `$TEAMRIG_TEAM`, which `open` sets.
 */
async function pointerStep(files: Files, team: string, project: string, tree: TeamTree): Promise<Checked<FileStep>> {
  // `$TEAMRIG_TEAM` says which team a command runs for, never which team a folder belongs to.
  const found = await resolveTeam(files, {}, [project]);
  switch (found.kind) {
    case 'none':
      return ok({ kind: 'create', path: join(project, TEAM_POINTER), text: formatConfig({ team }) });
    case 'broken':
      return fail(`${found.from} ${found.problem}; fix or remove it, then run this again`);
    case 'team':
      if (found.team === team) {
        return ok({ kind: 'keep', path: found.from, why: `the project is already tied to team ${team}` });
      }
      if (tree.sameTree(found.team, team)) {
        return ok({
          kind: 'keep',
          path: found.from,
          why: `the project stays tied to team ${found.team}, in the same tree as ${team}; open ${team}'s sessions with ${KIT_NAME} open ${team}/<id>`,
        });
      }
      return fail(`${project} is already tied to team ${found.team} by ${found.from}; give another --project, or remove that pointer first`);
  }
}

/** Checks the config, the team's place in the tree of every team in the kit home, and the project's pointer; nothing is written. */
export async function planTeamSetup(
  files: Files,
  format: ConfigFormat,
  spec: TeamSpec,
  configPath: string,
  project: string,
  tree: TeamTree,
): Promise<Checked<SetupPlan>> {
  const config = await configStep(files, format, spec, configPath);
  if (!config.ok) {
    return config;
  }
  // A kept config is in the tree already as it is; only a new one can break the tree.
  const placed = config.value.file.kind === 'create' ? treeStep(tree, spec) : ok(teamNodeOfSpec(spec));
  if (!placed.ok) {
    return placed;
  }
  const pointer = await pointerStep(files, spec.team, project, tree.with(placed.value));
  if (!pointer.ok) {
    return pointer;
  }
  return ok({ spec, config: config.value.file, pointer: pointer.value, tabStatus: config.value.tabStatus });
}

/**
 * Writes the plan's new files, the config first, each only if it is still absent. A failure after the
 * config leaves a state the next run completes: the config then matches and only the pointer is written.
 */
export async function applyTeamSetup(files: Files, plan: SetupPlan): Promise<Checked<SetupPlan>> {
  for (const step of [plan.config, plan.pointer]) {
    if (step.kind === 'create' && !(await files.createExclusive(step.path, step.text))) {
      return fail(`${step.path} appeared while the team was being set up; run the command again`);
    }
  }
  return ok(plan);
}

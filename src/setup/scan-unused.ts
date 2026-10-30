import type { Listed, ListedAgent, ListedSkill } from './scan-context.ts';
import { tokensOf, type Finding } from './scan-finding.ts';
import type { ScanReportContext } from './scan-report.ts';
import { outermostFolders, projectUse, type UsedIn } from './scan-usage.ts';
import type { SetupScan } from './scan.ts';
import type { DoctorSkill } from './skill-doctor.ts';

export const BYTES_PER_MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** An entry used only in other projects names up to this many of the folders it was used in. */
const FOLDERS_SHOWN = 2;

/** The UNUSED section of `teamrig setup scan`: its header line, its findings, and the listed skills they take off the listing. */
export interface UnusedSection {
  readonly header: string;
  readonly findings: readonly Finding[];
  /** The skills whose finding saves their whole listing line, so no other finding counts their description. */
  readonly skills: ReadonlySet<ListedSkill>;
}

/** A listing whose entries the section judges: its finding kind for an entry used only in other projects, and the folder it moves to. */
interface ListingKind {
  readonly elsewhere: string;
  readonly folder: string;
}

const SKILLS: ListingKind = { elsewhere: 'other-project-skill', folder: '.claude/skills' };
const AGENTS: ListingKind = { elsewhere: 'other-project-agent', folder: '.claude/agents' };

/** A user-level entry the transcripts read show in use only in sessions started outside the project, and where. */
interface UsedElsewhere {
  readonly kind: ListingKind;
  readonly entry: Listed;
  readonly folders: readonly string[];
}

/** What the section judged, for its header. */
interface Tally {
  readonly skills: number;
  readonly agents: number;
  /** Not used, but changed inside the window: too new to judge. */
  readonly young: number;
  /** Not in the transcripts read, but `/skill-doctor` saw them run in `--days`. */
  readonly ran: number;
  readonly elsewhere: number;
  /** False when no transcript read started in the project, so none is judged by where it was used. */
  readonly perProject: boolean;
  readonly doctorOnly: number;
}

/** The days the transcripts read cover: all --days of them, else the newest ones read before the bound. */
function windowOf(scan: SetupScan, at: ScanReportContext): string {
  return scan.usage.unread === 0 ? `${at.days} day(s)` : `the newest ${((at.now - scan.usage.since) / DAY_MS).toFixed(1)} day(s)`;
}

/** `/skill-doctor`'s rows by skill name; none when it was skipped. */
function doctorRows(scan: SetupScan): ReadonlyMap<string, DoctorSkill> {
  return new Map(scan.doctor.kind === 'read' ? scan.doctor.skills.map((row) => [row.name, row]) : []);
}

/** True when `/skill-doctor` saw the skill run on this machine in the last `days` days. */
function ranIn(row: DoctorSkill | undefined, days: number): boolean {
  return row !== undefined && row.uses > 0 && row.lastUsedDays !== undefined && row.lastUsedDays <= days;
}

/** What `/skill-doctor` tells of a skill's use: never, or how long ago; undefined when it has no row or no day count. */
function doctorNote(row: DoctorSkill | undefined): string | undefined {
  if (row?.uses === 0) {
    return 'never used on this machine';
  }
  return row?.lastUsedDays === undefined ? undefined : `last used ${row.lastUsedDays} day(s) ago`;
}

function unusedSkillFindings(unused: readonly ListedSkill[], rows: ReadonlyMap<string, DoctorSkill>, window: string, show: (path: string) => string): Finding[] {
  return unused.map((skill) => {
    const note = doctorNote(rows.get(skill.name));
    return {
      kind: 'unused-skill',
      where: show(skill.path),
      what: `no Skill call or /${skill.name} in ${window}${note === undefined ? '' : `; /skill-doctor: ${note}`}`,
      saves: tokensOf(skill.line.length),
    };
  });
}

function unusedAgentFindings(unused: readonly ListedAgent[], window: string, show: (path: string) => string): Finding[] {
  return unused.map((agent) => ({ kind: 'unused-agent', where: show(agent.path), what: `no Agent call ran ${agent.name} in ${window}`, saves: tokensOf(agent.line.length) }));
}

/**
 * The skills only `/skill-doctor` lists (plugins', synced ones, any outside the skill folders read) that cost a listing
 * line every turn and neither it nor a transcript saw run in `--days`.
 */
function doctorOnlyFindings(scan: SetupScan, at: ScanReportContext): Finding[] {
  if (scan.doctor.kind === 'skipped') {
    return [];
  }
  const folders = new Set(scan.context.skills.map((skill) => skill.name));
  return scan.doctor.skills.flatMap((row) => {
    const note = doctorNote(row);
    const judged = row.listed > 0 && !folders.has(row.name) && !scan.usage.skills.has(row.name) && !ranIn(row, at.days);
    return !judged || note === undefined ? [] : [{ kind: 'unused-skill', where: `${row.name} (${row.source})`, what: `${note} per /skill-doctor; turn it off in /skills`, saves: row.listed }];
  });
}

function notUsed(listed: readonly Listed[], used: UsedIn): Listed[] {
  return listed.filter((entry) => !used.has(entry.name));
}

/**
 * The user-level entries the transcripts read show in use, but none in a session started in the project or below it.
 * An entry used only in sessions whose start folder no transcript said is not one: it may have been used here.
 */
function usedElsewhere(kind: ListingKind, listed: readonly Listed[], used: UsedIn, here: ReadonlySet<string>): UsedElsewhere[] {
  return listed.flatMap((entry) => {
    const folders = used.get(entry.name);
    return entry.scope !== 'user' || folders === undefined || folders.size === 0 || here.has(entry.name) ? [] : [{ kind, entry, folders: outermostFolders(folders) }];
  });
}

function elsewhereFinding({ kind, entry, folders }: UsedElsewhere, window: string, show: (path: string) => string): Finding {
  const more = folders.length > FOLDERS_SHOWN ? ` and ${folders.length - FOLDERS_SHOWN} more` : '';
  return {
    kind: kind.elsewhere,
    where: show(entry.path),
    what: `used only in other projects in ${window}: ${folders.slice(0, FOLDERS_SHOWN).map(show).join(', ')}${more}; move it to their ${kind.folder}`,
    saves: tokensOf(entry.line.length),
  };
}

function unusedHeader(scan: SetupScan, tally: Tally, at: ScanReportContext): string {
  const { transcripts, bytes, unread } = scan.usage;
  const agents = scan.context.agents.length === 0 ? '' : ` and ${tally.agents} of ${scan.context.agents.length} agent type(s)`;
  const unjudged = tally.young === 0 ? '' : `; ${tally.young} more changed in that time, too new to judge`;
  const confirmed = tally.ran === 0 ? '' : `; ${tally.ran} more not in the transcripts read ran in ${at.days} day(s) per /skill-doctor`;
  const where = tally.perProject ? '' : ', not judged: no transcript read started in this project';
  const elsewhere = tally.elsewhere === 0 ? '' : `; ${tally.elsewhere} user-level one(s) used only in other projects${where}`;
  const only = tally.doctorOnly === 0 ? '' : `; and ${tally.doctorOnly} skill(s) only /skill-doctor lists`;
  const skipped = scan.doctor.kind === 'skipped' ? `; /skill-doctor skipped: ${scan.doctor.why}` : '';
  const bound = unread === 0 ? '' : `, newest first; ${unread} older one(s) of ${at.days} day(s) left unread past the ${at.maxMb} MB bound, --max-mb raises it`;
  const read = `read ${transcripts} transcript(s), ${(bytes / BYTES_PER_MB).toFixed(1)} MB${bound}`;
  return `UNUSED ${tally.skills} of ${scan.context.skills.length} skill(s)${agents} not used in ${windowOf(scan, at)} (${read})${unjudged}${confirmed}${elsewhere}${only}${skipped}`;
}

/**
 * The UNUSED section, judged by the transcripts read on the whole machine: the skills and agent types no transcript
 * used, of those whose file is older than the window (one written or changed inside it has not had the whole window to
 * be used, and a skill `/skill-doctor` saw run in `--days` is used, though the transcripts read past `--max-mb` may
 * cover fewer days), then the skills only `/skill-doctor` lists that never or long ago ran. Then by where the sessions
 * started: the user-level skills and agent types used only in other projects, which every session here lists for
 * nothing; judged only once a transcript read started in this project, and never for a skill only `/skill-doctor` saw
 * run, since it does not say where. Nothing is judged when there is no transcript to tell, since then every skill would
 * look unused.
 */
export function unusedSection(scan: SetupScan, at: ScanReportContext, show: (path: string) => string): UnusedSection {
  const { context, usage } = scan;
  if (usage.transcripts === 0) {
    return { header: `UNUSED not checked: no transcript on this machine in ${at.days} day(s)`, findings: [], skills: new Set() };
  }
  const rows = doctorRows(scan);
  const window = windowOf(scan, at);
  const isOld = (entry: Listed): boolean => !scan.recent.has(entry.path);
  const notUsedSkills = notUsed(context.skills, usage.skills);
  const notUsedAgents = notUsed(context.agents, usage.agents);
  const oldSkills = notUsedSkills.filter(isOld);
  const skills = oldSkills.filter((skill) => !ranIn(rows.get(skill.name), at.days));
  const agents = notUsedAgents.filter(isOld);
  const here = projectUse(usage, at.project);
  const elsewhere = [...usedElsewhere(SKILLS, context.skills, usage.skills, here.skills), ...usedElsewhere(AGENTS, context.agents, usage.agents, here.agents)];
  const moved = here.transcripts === 0 ? [] : elsewhere;
  const doctorOnly = doctorOnlyFindings(scan, at);
  const tally: Tally = {
    skills: skills.length,
    agents: agents.length,
    young: notUsedSkills.length - oldSkills.length + notUsedAgents.length - agents.length,
    ran: oldSkills.length - skills.length,
    elsewhere: elsewhere.length,
    perProject: here.transcripts > 0,
    doctorOnly: doctorOnly.length,
  };
  return {
    header: unusedHeader(scan, tally, at),
    findings: [
      ...unusedSkillFindings(skills, rows, window, show),
      ...doctorOnly,
      ...unusedAgentFindings(agents, window, show),
      ...moved.map((one) => elsewhereFinding(one, window, show)),
    ],
    skills: new Set([...skills, ...moved.filter((one) => one.kind === SKILLS).map((one) => one.entry)]),
  };
}

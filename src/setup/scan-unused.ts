import type { ListedSkill } from './scan-context.ts';
import { tokensOf, type Finding } from './scan-finding.ts';
import type { ScanReportContext } from './scan-report.ts';
import type { SetupScan } from './scan.ts';
import type { DoctorSkill } from './skill-doctor.ts';

export const BYTES_PER_MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The UNUSED section of `teamrig setup scan`: its header line, its findings, and the listed skills they judge unused. */
export interface UnusedSection {
  readonly header: string;
  readonly findings: readonly Finding[];
  readonly skills: readonly ListedSkill[];
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

function unusedFindings(unused: readonly ListedSkill[], rows: ReadonlyMap<string, DoctorSkill>, window: string, show: (path: string) => string): Finding[] {
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

function notUsed(scan: SetupScan): ListedSkill[] {
  return scan.context.skills.filter((skill) => !scan.usage.skills.has(skill.name));
}

function unusedHeader(scan: SetupScan, unused: readonly ListedSkill[], doctorOnly: number, at: ScanReportContext): string {
  const { transcripts, bytes, unread } = scan.usage;
  const rows = doctorRows(scan);
  const old = notUsed(scan).filter((skill) => !scan.recent.has(skill.path));
  const young = notUsed(scan).length - old.length;
  const unjudged = young === 0 ? '' : `; ${young} more changed in that time, too new to judge`;
  const ran = old.filter((skill) => ranIn(rows.get(skill.name), at.days)).length;
  const confirmed = ran === 0 ? '' : `; ${ran} more not in the transcripts read ran in ${at.days} day(s) per /skill-doctor`;
  const only = doctorOnly === 0 ? '' : `; and ${doctorOnly} skill(s) only /skill-doctor lists`;
  const skipped = scan.doctor.kind === 'skipped' ? `; /skill-doctor skipped: ${scan.doctor.why}` : '';
  const bound = unread === 0 ? '' : `, newest first; ${unread} older one(s) of ${at.days} day(s) left unread past the ${at.maxMb} MB bound, --max-mb raises it`;
  const read = `read ${transcripts} transcript(s), ${(bytes / BYTES_PER_MB).toFixed(1)} MB${bound}`;
  return `UNUSED ${unused.length} of ${scan.context.skills.length} skill(s) not used in ${windowOf(scan, at)} (${read})${unjudged}${confirmed}${only}${skipped}`;
}

/**
 * The UNUSED section: the skills no transcript used, of those whose file is older than the window (a skill written or
 * changed inside it has not had the whole window to be used, and one `/skill-doctor` saw run in `--days` is used,
 * though the transcripts read past `--max-mb` may cover fewer days), then the skills only `/skill-doctor` lists that
 * never or long ago ran. Nothing is judged when there is no transcript to tell, since then every skill would look unused.
 */
export function unusedSection(scan: SetupScan, at: ScanReportContext, show: (path: string) => string): UnusedSection {
  if (scan.usage.transcripts === 0) {
    return { header: `UNUSED not checked: no transcript on this machine in ${at.days} day(s)`, findings: [], skills: [] };
  }
  const rows = doctorRows(scan);
  const skills = notUsed(scan).filter((skill) => !scan.recent.has(skill.path) && !ranIn(rows.get(skill.name), at.days));
  const doctorOnly = doctorOnlyFindings(scan, at);
  return {
    header: unusedHeader(scan, skills, doctorOnly.length, at),
    findings: [...unusedFindings(skills, rows, windowOf(scan, at), show), ...doctorOnly],
    skills,
  };
}

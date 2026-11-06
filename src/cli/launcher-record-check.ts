import type { Files } from '../core/files.ts';
import { KIT_NAME } from '../core/home.ts';
import { launcherRecordPath, readLauncherRecord } from '../restore/launcher-refresh.ts';
import type { RegisteredPart } from '../restore/launcher-survey.ts';
import type { UnownedWarning } from './unowned.ts';

/** The first of the part's program and script that is gone; undefined when both are there. */
async function goneOf(files: Files, part: RegisteredPart): Promise<string | undefined> {
  for (const path of [part.program, part.script]) {
    if ((await files.stamp(path)) === undefined) {
      return path;
    }
  }
  return undefined;
}

/**
 * RESTORE-DEAD and RESTORE-STRAY (T2030), for `check`: from the launcher record (src/restore/launcher-refresh.ts), each
 * part teamrig set up to start the restore (the logon entry, a shortcut) whose program or script is gone, such as a pin
 * left on a Node or a launcher a cleanup removed, and each shortcut or logon entry of teamrig's name that starts
 * anything else. It reads only the record and looks each registered file up, and spawns nothing: the refresh at each
 * new version's first session start, `restore install` and `restore uninstall` read the machine and write the record.
 * A record of no survey (none, an older format or a newer one) flags nothing. The restore is this machine's, every
 * team's, not one session's area, so each is a warning no session owns and goes to the lead.
 */
export async function restoreLauncherWarnings(files: Files, kitHome: string): Promise<UnownedWarning[]> {
  const survey = (await readLauncherRecord(files, kitHome))?.survey;
  if (survey === undefined) {
    return [];
  }
  const source = `the restore launcher record ${launcherRecordPath(kitHome)}`;
  const dead: UnownedWarning[] = [];
  for (const part of survey.registered) {
    const gone = await goneOf(files, part);
    if (gone !== undefined) {
      const text = `RESTORE-DEAD ${part.where} starts ${gone}, which is gone: run ${KIT_NAME} restore install --yes, which writes the launchers and repoints it`;
      dead.push({ key: `restore-dead ${part.where}`, source, text });
    }
  }
  const stray = survey.found.map((part) => ({
    key: `restore-stray ${part.where}`,
    source,
    text:
      `RESTORE-STRAY ${part.where} runs ${part.runs}, not what ${KIT_NAME} restore install set up: run ${KIT_NAME} restore install --yes to repoint it, ` +
      `or remove it and run ${KIT_NAME} restore install --yes (uninstall --yes where nothing should restore at logon) to update the record`,
  }));
  return [...dead, ...stray];
}

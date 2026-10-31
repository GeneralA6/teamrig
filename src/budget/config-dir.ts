import type { Files } from '../core/files.ts';
import { isRecord, stringField } from '../core/guards.ts';

/** The record's format; a record of another format reads as none. */
const FORMAT = 1;

/**
 * The Claude config dir a team's sessions last started in, as each start records it in the team's usage folder
 * (`TeamPaths.configDirRecord`), so another team of the kit home tells which login the team is on: one config dir signs
 * in one account (budget/account.ts `accountsOf`). Undefined when none is recorded, or the record cannot be read.
 */
export async function readConfigDir(files: Pick<Files, 'read'>, path: string): Promise<string | undefined> {
  try {
    const text = await files.read(path);
    if (text === undefined) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && parsed['v'] === FORMAT ? stringField(parsed, 'configDir') : undefined;
  } catch {
    return undefined;
  }
}

/** Records `configDir` as the team's (`readConfigDir`), writing only when the record names another or none. */
export async function recordConfigDir(files: Pick<Files, 'read' | 'write'>, path: string, configDir: string): Promise<void> {
  if ((await readConfigDir(files, path)) !== configDir) {
    await files.write(path, `${JSON.stringify({ v: FORMAT, configDir })}\n`);
  }
}

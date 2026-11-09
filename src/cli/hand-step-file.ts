import { resolve } from 'node:path';
import { sha256Hex, type AuditPin } from '../register/hand-step.ts';
import { UsageError } from './args.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * The pin of the hand step file `typed` names (T2312, core rule 11), read from the caller's folder: its absolute path
 * and the sha256 of its bytes now, as `audit --file` pins it and `set --run` matches it. `flag` names the flag that
 * typed it, for the usage error a blank path or one with a line break gets (parseAuditPin reads such a pin back as
 * bad, so the register line it wrote would be lost); a missing file is refused.
 */
export async function handStepPin(runtime: CliRuntime, flag: string, typed: string): Promise<AuditPin> {
  if (typed.trim() === '') {
    throw new UsageError(`--${flag} needs the hand step file's path`);
  }
  if (/[\r\n]/.test(typed)) {
    throw new UsageError(`--${flag} takes the hand step file's path on one line: a path with a line break is not pinned`);
  }
  const path = resolve(runtime.cwd, typed);
  const bytes = await runtime.fileBytes.read(path);
  if (bytes === undefined) {
    throw new RefusedError(`no file ${path}`);
  }
  return { path, sha256: sha256Hex(bytes) };
}

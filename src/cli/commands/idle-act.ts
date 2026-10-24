import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { onePositional, requiredFlag, type ParsedArgs } from '../args.ts';
import { closeSession } from '../close-session.ts';
import { closableText, idleFactsOf, type IdleVerdict } from '../idle-check.ts';
import { runningVerdictOf } from '../idle-pass.ts';
import { formatIdlePassRecord, type IdleActRecord } from '../idle-pass-log.ts';
import { openKit, requireConfig, rosterOf, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { idFlag } from './open.ts';

/** Who the session log names as the closer of a session the idle pass closed. */
export const IDLE_PASS_CLOSER = 'idle-pass';

/** The session's verdict, or the error that kept it from being weighed (the host's processes not listed, say). */
async function verdictOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, id: string, project: string): Promise<IdleVerdict | { readonly kind: 'failed'; readonly error: string }> {
  try {
    return await runningVerdictOf(runtime, kit, config, roster, await idleFactsOf(runtime, kit, config, roster), id, project);
  } catch (error) {
    return { kind: 'failed', error: errorMessage(error) };
  }
}

/**
 * `idle-close <id> --team <team> --project <dir>`: one close the idle pass decided (T1100), which the pass starts
 * hidden, since ending a tab takes up to about 20 s and the mod ends a wake check at 30. Work may have reached the
 * session since the pass, so it weighs it again as the pass does (`runningVerdictOf`): kept, it ends nothing; else it
 * ends its Claude Code and its tab and logs the close by `idle-pass` (`closeSession`). It runs unseen, so each outcome
 * is a line in the pass log, with the host's commit charge before and after a close; exit 1 when it could not weigh
 * the session or did not close one it found closable. The pass reads `open.idle.mode` before it starts one, so this
 * does not.
 */
export async function idleClose(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = idFlag('session', onePositional(args, 'id'));
  const team = idFlag('--team', requiredFlag(args.flags, 'team'));
  const project = requiredFlag(args.flags, 'project');
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const label = `${roster.nameOf(id) ?? id} (session ${id})`;
  const act = { kind: 'act', mode: config.open.idle.mode, act: 'close', id } as const;
  const verdict = await verdictOf(runtime, kit, config, roster, id, project);
  const unmeasured = { before: undefined, after: undefined };
  switch (verdict.kind) {
    case 'keep':
      return report(runtime, kit, { ...act, ...unmeasured, at: runtime.clock.now(), outcome: 'kept', line: `KEPT ${verdict.why}` });
    case 'failed':
      return report(runtime, kit, { ...act, ...unmeasured, at: runtime.clock.now(), outcome: 'failed', line: `FAILED to weigh ${label}: ${verdict.error}` });
    case 'close': {
      const before = await runtime.memory.commit();
      const problem = await closeSession(runtime, kit.paths, { id, by: IDLE_PASS_CLOSER, closable: verdict.closable });
      const done = { ...act, at: runtime.clock.now(), before, after: await runtime.memory.commit() };
      return report(
        runtime,
        kit,
        problem === undefined
          ? { ...done, outcome: 'done', line: `CLOSED ${label}: ${closableText(verdict.closable)}, now free` }
          : { ...done, outcome: 'failed', line: `FAILED to close ${label}: ${problem}` },
      );
    }
  }
}

/**
 * Logs the act and prints its line; exit 1 when it failed. A log it cannot write is said, but is no reason to fail a
 * close that already happened.
 */
async function report(runtime: CliRuntime, kit: Kit, record: IdleActRecord): Promise<ExitCode> {
  try {
    await runtime.files.append(kit.paths.idlePassLog, formatIdlePassRecord(record));
  } catch (error) {
    runtime.out.stderr(`WARN the idle pass log was not written: ${errorMessage(error)}`);
  }
  runtime.out.stdout(record.line);
  return record.outcome === 'failed' ? EXIT.failed : EXIT.ok;
}

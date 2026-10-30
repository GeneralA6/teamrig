import { demoted, promoted, type Leads } from '../../config/lead-edits.ts';
import { writeConfigWithBackup } from '../../config/load.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import type { JsonRecord } from '../../core/guards.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { postLine } from '../../inbox/inbox.ts';
import type { Checked } from '../../setup/team-create.ts';
import { onePositional, UsageError, type ParsedArgs } from '../args.ts';
import { callerOf, listOf } from '../inputs.ts';
import { checkedNextConfig, configFileJson, openTeamKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';
import { fileLockOf } from '../file-locks.ts';

/**
 * `promote` and `demote` (T781): a leader (the lead, or a sub-lead) makes one of the sessions it leads directly the
 * sub-lead of others it leads directly, or takes a sub-lead's group back. A sub-lead answers its members' decision and
 * approval waits, as the lead above it still may. Without --yes each only shows the change; with it, the old config is
 * kept in the backups folder, `leads` is rewritten, and the sub-lead gets one inbox line.
 */

/** The backup names of a config before `promote` or `demote` changed it. */
export const PROMOTE_BACKUP_NAME = 'config.promote';
export const DEMOTE_BACKUP_NAME = 'config.demote';

/** One edit of the tree: how it plans the next `leads`, and how it reads. */
interface LeadsChange {
  readonly backupName: string;
  plan(config: KitConfig, caller: string, subLead: string): Checked<Leads>;
  /** What the change does, for the preview and the written line. */
  describe(config: KitConfig, next: Leads, caller: string, subLead: string): string;
  /** The sub-lead's inbox line. */
  tell(config: KitConfig, next: Leads, caller: string, subLead: string): string;
}

/** The file with `leads` replaced, or gone once no sub-lead is left. */
function withLeads(file: JsonRecord, leads: Leads): JsonRecord {
  return Object.keys(leads).length === 0 ? Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'leads')) : { ...file, leads };
}

function promoteChange(members: readonly string[]): LeadsChange {
  return {
    backupName: PROMOTE_BACKUP_NAME,
    plan: (config, caller, subLead) => promoted(config, caller, subLead, members),
    describe: (_config, next, caller, subLead) => `${subLead} leads ${(next[subLead] ?? []).join(', ')}, under ${caller}`,
    tell: (_config, next, caller, subLead) =>
      `${caller} made you a sub-lead over ${(next[subLead] ?? []).join(', ')}: their decision and approval waits may come to you, answered with teamrig approve`,
  };
}

const DEMOTE: LeadsChange = {
  backupName: DEMOTE_BACKUP_NAME,
  plan: (config, caller, subLead) => demoted(config, caller, subLead),
  describe: (config, _next, caller, subLead) => `${subLead} leads no one; ${(config.leads[subLead] ?? []).join(', ')} go back to ${caller}`,
  tell: (config, _next, caller, subLead) => `${caller} took back the sessions you led (${(config.leads[subLead] ?? []).join(', ')}); you lead no one now`,
};

async function changeLeads(args: ParsedArgs, runtime: CliRuntime, verb: 'promote' | 'demote', changeOf: (roster: Roster) => LeadsChange): Promise<ExitCode> {
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'write');
  const roster = await rosterOf(runtime, kit, config);
  const by = sessionIdOf(roster, caller);
  const subLead = sessionIdOf(roster, onePositional(args, 'sub-lead'));
  const change = changeOf(roster);
  const { files, clock } = runtime;
  // The hire log's lock: hire and retire also rewrite the team's shape, retire `leads` too.
  const mutex = fileLockOf(runtime, kit.paths.hiresLock, config.lock);
  return mutex.run(async () => {
    const file = await configFileJson(runtime, kit.load.path);
    // Planned on the file as it is under the lock, so a retire that just rewrote `leads` is not undone.
    const current = checkedNextConfig(file);
    const planned = change.plan(current, by, subLead);
    if (!planned.ok) {
      throw new RefusedError(planned.problem);
    }
    const next = withLeads(file, planned.value);
    checkedNextConfig(next);
    const what = change.describe(current, planned.value, by, subLead);
    if (!args.switches.has('yes')) {
      runtime.out.stdout(`PREVIEW ${verb} ${what}; nothing written (add --yes to write)`);
      return EXIT.ok;
    }
    const backup = await writeConfigWithBackup(files, { configPath: kit.load.path, backupsDir: kit.paths.backups, backupName: change.backupName }, next, clock);
    runtime.out.stdout(`${verb === 'promote' ? 'PROMOTED' : 'DEMOTED'} ${what}; the old config is at ${backup}`);
    const text = change.tell(current, planned.value, by, subLead);
    const { inboxes } = inboxDepsOf(runtime, kit.paths);
    const problem = await postLine(inboxes, new SecretScanner(config.register.secretPatterns), { to: subLead, from: by, text, now: new Date(clock.now()) });
    runtime.out.stderr(problem === undefined ? `NOTE ${subLead} has an inbox line: ${text}` : `WARN ${subLead} was not told: ${problem}`);
    return EXIT.ok;
  });
}

/** `promote <sub-lead> --members <a,b> [--yes]`. */
export async function promote(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const members = args.flags.get('members');
  if (members === undefined) {
    throw new UsageError('promote needs --members <a,b>: the sessions the sub-lead will lead');
  }
  return changeLeads(args, runtime, 'promote', (roster) => promoteChange(listOf('--members', members).map((member) => sessionIdOf(roster, member))));
}

/** `demote <sub-lead> [--yes]`. */
export async function demote(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  return changeLeads(args, runtime, 'demote', () => DEMOTE);
}

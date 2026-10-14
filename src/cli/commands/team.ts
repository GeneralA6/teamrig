import { isRole, type Roster } from '../../config/roster.ts';
import { UsageError, type ParsedArgs } from '../args.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/** One roster line: `<id> <name>`, then the roles the session holds. */
function rosterLine(roster: Roster, id: string): string {
  const roles = roster.rolesOf(id);
  return `${id} ${roster.nameOf(id) ?? id}${roles.length === 0 ? '' : ` (${roles.join(', ')})`}`;
}

/** A session by id or name, else the holder of a role, so `who lead` works whatever the lead's id. */
function idOf(roster: Roster, text: string): string {
  const found = roster.lookup(text);
  if (found.ok || !isRole(text)) {
    return sessionIdOf(roster, text);
  }
  const holder = roster.holderOf(text);
  if (holder === undefined) {
    throw new RefusedError(`no session holds the ${text} role`);
  }
  return holder;
}

/** `who [<id|name|role>]`: the name to message a session by; with no argument, every session. */
export async function who(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [text, extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  const kit = await openTeamKit(runtime);
  const roster = rosterOf(kit, requireConfig(kit, runtime, 'read'));
  if (text === undefined) {
    roster.ids.forEach((id) => runtime.out.stdout(rosterLine(roster, id)));
    return EXIT.ok;
  }
  const id = idOf(roster, text);
  runtime.out.stdout(roster.nameOf(id) ?? id);
  return EXIT.ok;
}

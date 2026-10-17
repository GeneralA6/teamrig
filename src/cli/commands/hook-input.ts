import { join } from 'node:path';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { isRecord, stringField } from '../../core/guards.ts';
import { claudeConfigDir, ENV } from '../../core/home.ts';
import { resolveTeam, type TeamResolution } from '../../core/team.ts';
import { OwnPaths } from '../../hooks/lead-boundary.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { indexMarks } from '../../inbox/marks.ts';
import { teamFolders, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';

/** A hook's stdin as JSON; undefined when it is not JSON, which every hook treats as nothing to do. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The team a session's hooks run for: `$TEAMRIG_TEAM`, else the nearest pointer above the folder the
 * session started in (`$CLAUDE_PROJECT_DIR`), then the payload's folder. The payload's `cwd` follows
 * a `cd`, so walking it first would let a tab that moved into another team's project read, and bind
 * to, that team's sessions. The push guard keeps `hookTeam`: a push belongs to the folder it runs in.
 */
export function sessionTeam(payload: unknown, runtime: CliRuntime): Promise<TeamResolution> {
  const cwd = isRecord(payload) ? stringField(payload, 'cwd') : undefined;
  return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.env[ENV.claudeProjectDir], cwd, runtime.cwd]));
}

/** `$TEAMRIG_SESSION` as Claude Code passed it to the hook; undefined when unset or blank. */
export function envSession(runtime: CliRuntime): string | undefined {
  const session = runtime.env[ENV.session]?.trim();
  return session === '' ? undefined : session;
}

/**
 * The team session a hook runs for: `$TEAMRIG_SESSION` when it is set (an id or any name the
 * session has had), else the area this Claude Code session last read its inbox as.
 */
export async function teamSessionOf(runtime: CliRuntime, kit: Kit, roster: Roster, claudeSession: string | null): Promise<string | undefined> {
  const session = envSession(runtime);
  if (session !== undefined) {
    const found = roster.lookup(session);
    return found.ok ? found.id : undefined;
  }
  return markedSessionOf(runtime, kit, roster, claudeSession);
}

/**
 * The area this Claude Code session last read its inbox as, or was bound to by its title, when it is
 * on the roster. It is how a tab started without `$TEAMRIG_SESSION`, such as the one that set the team
 * up, stays its session.
 */
export async function markedSessionOf(runtime: CliRuntime, kit: Kit, roster: Roster, claudeSession: string | null): Promise<string | undefined> {
  if (claudeSession === null) {
    return undefined;
  }
  const { marks } = await inboxDepsOf(runtime, kit.paths).marks.read();
  const area = indexMarks(marks).areaBySession.get(claudeSession);
  return area !== undefined && roster.ids.includes(area) ? area : undefined;
}

/**
 * `markedSessionOf` for a start's context (a session's or its helper's), which must always load: a failed
 * read means no session. A helper's hooks carry the session id of the session that started it.
 */
export async function startSessionOf(runtime: CliRuntime, kit: Kit, roster: Roster, payload: unknown): Promise<string | undefined> {
  try {
    return await markedSessionOf(runtime, kit, roster, sessionIdOf(payload));
  } catch {
    return undefined;
  }
}

/** The lead's own paths in this team: its teamrig folder, Claude Code's memory folders and `leadBoundary.ownPaths`. */
export function leadOwnPaths(runtime: CliRuntime, kit: Kit, config: KitConfig): OwnPaths {
  const memory = join(claudeConfigDir(runtime.env, runtime.userHome), 'projects', '*', 'memory');
  return new OwnPaths([kit.paths.home, memory, ...config.leadBoundary.ownPaths], runtime.userHome);
}

import type { Roster } from '../../config/roster.ts';
import { isRecord, stringField } from '../../core/guards.ts';
import { ENV } from '../../core/home.ts';
import { resolveTeam, type TeamResolution } from '../../core/team.ts';
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

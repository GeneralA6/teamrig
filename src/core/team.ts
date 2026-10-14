import { dirname, join, resolve } from 'node:path';
import type { Files } from './files.ts';
import { errorMessage, isRecord } from './guards.ts';
import { ENV, type Env } from './home.ts';
import { ID_PATTERN, ID_RULE } from './ids.ts';

/** The file that ties a project folder, and every folder below it, to a team: `{"team": "<id>"}`. */
export const TEAM_POINTER = '.teamrig.json';

/**
 * The team a command or hook runs for. `from` says where it was found: `$TEAMRIG_TEAM` or the
 * pointer file's path. `none` is not an error: outside a team's projects a hook stays silent.
 */
export type TeamResolution =
  | { readonly kind: 'team'; readonly team: string; readonly from: string }
  | { readonly kind: 'broken'; readonly from: string; readonly problem: string }
  | { readonly kind: 'none' };

const ENV_SOURCE = `$${ENV.team}`;

/**
 * `$TEAMRIG_TEAM` wins, so a session working in another team's repo keeps its own team. Otherwise
 * the nearest pointer file, walking up from each folder in order; a folder already walked from an
 * earlier start is not read twice.
 */
export async function resolveTeam(files: Files, env: Env, folders: readonly string[]): Promise<TeamResolution> {
  const fromEnv = env[ENV.team]?.trim();
  if (fromEnv) {
    return checkTeam(fromEnv, ENV_SOURCE);
  }
  const walked = new Set<string>();
  for (const folder of folders) {
    for (let dir = resolve(folder); !walked.has(dir); dir = dirname(dir)) {
      walked.add(dir);
      const found = await readPointer(files, join(dir, TEAM_POINTER));
      if (found !== undefined) {
        return found;
      }
    }
  }
  return { kind: 'none' };
}

async function readPointer(files: Files, path: string): Promise<TeamResolution | undefined> {
  let text: string | undefined;
  try {
    text = await files.read(path);
  } catch (error) {
    return { kind: 'broken', from: path, problem: `cannot be read (${errorMessage(error)})` };
  }
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'broken', from: path, problem: 'is not JSON; expected {"team": "<id>"}' };
  }
  const team = isRecord(parsed) ? parsed['team'] : undefined;
  return typeof team === 'string' ? checkTeam(team, path) : { kind: 'broken', from: path, problem: 'has no "team" text; expected {"team": "<id>"}' };
}

function checkTeam(team: string, from: string): TeamResolution {
  return ID_PATTERN.test(team) ? { kind: 'team', team, from } : { kind: 'broken', from, problem: `"${team}" is not a team id (${ID_RULE})` };
}

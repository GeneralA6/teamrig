import { isRecord, isStringArray, type HostPermissions, type JsonRecord, type PermissionsAnswer, type PermissionsReading, type TrustedRoutesPlan } from '../../../plugin-api/index.ts';

/**
 * Claude Code's permission rules: `permissions.allow` and `permissions.deny` in a settings file, the deny lines that
 * keep a session's tools off the credential homes, and auto mode's `autoMode.environment`, the trusted facts its
 * classifier reads. teamrig never writes a deny line: doctor and `check` print the missing ones for the user to paste.
 */

const PERMISSIONS_KEY = 'permissions';
const ALLOW_KEY = 'allow';
const DENY_KEY = 'deny';
const MODE_KEY = 'defaultMode';
const BYPASS_MODE = 'bypassPermissions';
const AUTO_MODE_KEY = 'autoMode';
const ENVIRONMENT_KEY = 'environment';
/** The list item that stands for Claude Code's built-in environment entries. */
export const DEFAULTS_ITEM = '$defaults';

/**
 * A deny line beats any hook's allow and auto mode's classifier, so it holds where a read-only allow hook would approve
 * `cat` of a secret file.
 *
 * Verified with canaries on Claude Code 2.1.303 (10-19, skill security-deny-verify): each of the first eleven refuses
 * its call; a Read deny also refuses Write and Edit of the path, and Grep skips the file. The rest are the same rule
 * forms on other paths. A rule ending in `:*` is the legacy prefix form, so `PowerShell(Get-ChildItem env:*)` misses
 * `Get-ChildItem env:X`; `env*` matches both. gh's line names its hosts file where gh keeps it on the platform
 * (`ghHostsDenyLine`); the space in `GitHub CLI` was proven on Claude Code 2.1.318 (11-05, T662).
 */
export function secretDenyLines(platform: NodeJS.Platform): readonly string[] {
  return [...SHARED_DENY_LINES, ghHostsDenyLine(platform), ...KEY_DENY_LINES];
}

/**
 * gh's hosts file, which names the account and can hold its token: under the roaming app data folder on Windows,
 * under `~/.config/gh` elsewhere. A team is told only its own platform's line (T2038: the Linux line alone guarded
 * nothing on Windows).
 */
export function ghHostsDenyLine(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Read(~/AppData/Roaming/GitHub CLI/hosts.yml)' : 'Read(~/.config/gh/hosts.yml)';
}

const SHARED_DENY_LINES: readonly string[] = [
  'Read(//**/secrets.yaml)',
  'Read(//**/.env)',
  'Read(~/.npmrc)',
  'Bash(kubectl *get*secret*)',
  'Bash(kubectl exec *printenv*)',
  'Bash(kubectl exec *-- env*)',
  'Bash(env)',
  'Bash(printenv*)',
  'PowerShell(Get-Content *secrets.yaml*)',
  'PowerShell(Get-Content *.env*)',
  'PowerShell(Get-ChildItem env*)',
  'Read(~/.ssh/id_*)',
  'Read(~/.aws/credentials)',
  'Read(~/.kube/config)',
  'Read(~/.docker/config.json)',
  'Read(~/.git-credentials)',
];

/** Claude Code's own login (T2007 found no line for it), then the key stores. */
const KEY_DENY_LINES: readonly string[] = ['Read(~/.claude/.credentials.json)', 'Read(//**/*.pem)', 'Read(//**/*.key)'];

/** The `permissions` object, none when the file has none; a problem when it is something else. */
function permissionsOf(settings: JsonRecord): PermissionsAnswer<JsonRecord> {
  const permissions = settings[PERMISSIONS_KEY] ?? {};
  return isRecord(permissions) ? { ok: true, value: permissions } : { ok: false, problem: `${PERMISSIONS_KEY} is not an object` };
}

function allowOf(permissions: JsonRecord): PermissionsAnswer<readonly string[]> {
  const allow = permissions[ALLOW_KEY] ?? [];
  return isStringArray(allow) ? { ok: true, value: allow } : { ok: false, problem: `${PERMISSIONS_KEY}.${ALLOW_KEY} is not a list of texts` };
}

/** Reads the deny list leniently: a deny line is only ever added by hand, so the texts in it are what holds. */
function read(settings: JsonRecord): PermissionsReading {
  const permissions = settings[PERMISSIONS_KEY];
  const rules = isRecord(permissions) ? permissions : {};
  const list = rules[DENY_KEY];
  const deny = Array.isArray(list) ? list.filter((rule): rule is string => typeof rule === 'string') : [];
  const held = permissionsOf(settings);
  const allow = held.ok ? allowOf(held.value) : held;
  const bypass = rules[MODE_KEY] === BYPASS_MODE ? `${PERMISSIONS_KEY}.${MODE_KEY} is ${BYPASS_MODE}` : undefined;
  return { allow, deny, bypass };
}

function writeAllow(settings: JsonRecord, allow: readonly string[]): PermissionsAnswer<JsonRecord> {
  const permissions = permissionsOf(settings);
  if (!permissions.ok) {
    return permissions;
  }
  return { ok: true, value: { ...settings, [PERMISSIONS_KEY]: { ...permissions.value, [ALLOW_KEY]: [...allow] } } };
}

interface Current {
  readonly autoMode: JsonRecord;
  /** The list, or undefined when there is none. */
  readonly environment: readonly string[] | undefined;
}

/**
 * Install puts the team's lines where its tagged lines were (or at the end), and leaves the person's own lines and
 * other teams' tagged lines as they are. A list without `"$defaults"` replaces Claude Code's built-in entries, so a
 * machine with no list gets `"$defaults"` first and keeps them.
 */
function installRoutes(settings: JsonRecord, tag: string, lines: readonly string[]): PermissionsAnswer<TrustedRoutesPlan> {
  const current = currentOf(settings);
  if (!current.ok) {
    return current;
  }
  const before = current.value.environment ?? [DEFAULTS_ITEM];
  const first = before.findIndex((item) => item.startsWith(tag));
  const kept = before.filter((item) => !item.startsWith(tag));
  const at = first === -1 ? kept.length : first;
  const after = [...kept.slice(0, at), ...lines, ...kept.slice(at)];
  if (current.value.environment !== undefined && sameList(before, after)) {
    return { ok: true, value: { settings: undefined, removed: [], added: [] } };
  }
  const was = current.value.environment ?? [];
  return {
    ok: true,
    value: {
      settings: { ...settings, [AUTO_MODE_KEY]: { ...current.value.autoMode, [ENVIRONMENT_KEY]: after } },
      removed: was.filter((item) => !after.includes(item)),
      added: after.filter((item) => !was.includes(item)),
    },
  };
}

/** Uninstall takes the team's lines out; a list left as only `"$defaults"` reads as no list and is dropped, and so is an `autoMode` left empty. */
function uninstallRoutes(settings: JsonRecord, tag: string): PermissionsAnswer<TrustedRoutesPlan> {
  const current = currentOf(settings);
  if (!current.ok) {
    return current;
  }
  const before = current.value.environment ?? [];
  const removed = before.filter((item) => item.startsWith(tag));
  if (removed.length === 0) {
    return { ok: true, value: { settings: undefined, removed: [], added: [] } };
  }
  const after = before.filter((item) => !item.startsWith(tag));
  const others = without(current.value.autoMode, ENVIRONMENT_KEY);
  const autoMode = sameList(after, [DEFAULTS_ITEM]) ? others : { ...others, [ENVIRONMENT_KEY]: after };
  const rest = without(settings, AUTO_MODE_KEY);
  const next = Object.keys(autoMode).length === 0 ? rest : { ...rest, [AUTO_MODE_KEY]: autoMode };
  return { ok: true, value: { settings: next, removed, added: [] } };
}

/** An `autoMode` or a list of any other shape is refused, never rewritten. */
function currentOf(settings: JsonRecord): PermissionsAnswer<Current> {
  const autoMode = settings[AUTO_MODE_KEY] ?? {};
  if (!isRecord(autoMode)) {
    return { ok: false, problem: `${AUTO_MODE_KEY} is not an object, so nothing can be added to it` };
  }
  const environment = autoMode[ENVIRONMENT_KEY];
  if (environment === undefined) {
    return { ok: true, value: { autoMode, environment: undefined } };
  }
  if (!isStringArray(environment)) {
    return { ok: false, problem: `${AUTO_MODE_KEY}.${ENVIRONMENT_KEY} is not a list of strings: fix it by hand, then run this again` };
  }
  return { ok: true, value: { autoMode, environment } };
}

function without(record: JsonRecord, key: string): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** The permissions port of the Claude Code adapter. */
export const hostPermissions: HostPermissions = {
  allowSetting: `${PERMISSIONS_KEY}.${ALLOW_KEY}`,
  denySetting: `${PERMISSIONS_KEY}.${DENY_KEY}`,
  routesSetting: `${AUTO_MODE_KEY}.${ENVIRONMENT_KEY}`,
  read,
  denyLines: secretDenyLines,
  writeAllow,
  installRoutes,
  uninstallRoutes,
};

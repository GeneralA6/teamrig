import { join } from 'node:path';
import { clipEnd } from '../core/clip.ts';
import type { Files } from '../core/files.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { jsonObjectOf } from '../doctor/settings-env.ts';
import { hookCommandLine, hookCommandsOf } from '../doctor/settings-hooks.ts';
import { countOf, formatCounts, type KeepList } from '../permissions/allow-rules.ts';
import type { SettingsFile } from '../permissions/settings-scope.ts';
import { planScope, type ReadPlan } from '../permissions/trim.ts';
import { CONTEXT_HOOK_EVENTS } from './scan-hook-output.ts';

/** What a settings check finds: allow rules a trim removes, no deny rule, prompts turned off, a hook that writes into the context. */
export type SettingsFindingKind = 'wide-allow' | 'no-deny' | 'bypass' | 'context-hook';

export interface SettingsFinding {
  readonly kind: SettingsFindingKind;
  readonly path: string;
  readonly what: string;
  /** How many worktree copies of the file hold this same finding besides the one at `path`, folded into it. */
  readonly copies: number;
}

/** A file's finding, before the same one in the file's worktree copies is folded in. */
type FileFinding = Omit<SettingsFinding, 'copies'>;

/** A hook's command prints up to this many characters. */
const HOOK_COMMAND_MAX_CHARS = 80;

function permissionsOf(settings: JsonRecord): JsonRecord {
  const permissions = settings['permissions'];
  return isRecord(permissions) ? permissions : {};
}

function hasDeny(settings: JsonRecord): boolean {
  const deny = permissionsOf(settings)['deny'];
  return Array.isArray(deny) && deny.length > 0;
}

function wideFindings(plan: ReadPlan): FileFinding[] {
  const removed = countOf(plan.trim.removed);
  return removed === 0 ? [] : [{ kind: 'wide-allow', path: plan.file.path, what: `${removed} allow rule(s) approve a whole tool or hold a credential: ${formatCounts(plan.trim.removed)}` }];
}

function fileFindings(path: string, settings: JsonRecord, secrets: SecretScanner): FileFinding[] {
  const found: FileFinding[] = [];
  if (permissionsOf(settings)['defaultMode'] === 'bypassPermissions') {
    found.push({ kind: 'bypass', path, what: 'permissions.defaultMode is bypassPermissions: every tool call runs without asking' });
  }
  for (const hook of hookCommandsOf(settings, CONTEXT_HOOK_EVENTS)) {
    const shown = clipEnd(secrets.redact(hookCommandLine(hook)), HOOK_COMMAND_MAX_CHARS);
    found.push({ kind: 'context-hook', path, what: `${hook.event} hook "${shown}": what it prints enters the context` });
  }
  return found;
}

/**
 * The settings findings of the Claude Code settings files in `scope`: per file, the allow rules a `permissions trim`
 * removes (counted by class, never printed), prompts turned off, and the hooks whose output enters every session's
 * context, the same finding in a file's worktree copies folded into its first, with their count; then one finding
 * when no file denies anything. It only reads.
 */
export async function scanSettings(files: Files, claudeDir: string, scope: readonly SettingsFile[], keep: KeepList, secrets: SecretScanner): Promise<SettingsFinding[]> {
  /** Keyed by the file (a worktree's copy as the project folder's own), the kind and the words. */
  const found = new Map<string, SettingsFinding>();
  let denies = false;
  for (const plan of await planScope(files, scope, keep, 'wide', secrets)) {
    if (plan.kind !== 'read') {
      continue;
    }
    const settings = jsonObjectOf(plan.text) ?? {};
    denies ||= hasDeny(settings);
    const file = plan.file.projectFile ?? plan.file.path;
    for (const finding of [...wideFindings(plan), ...fileFindings(plan.file.path, settings, secrets)]) {
      const key = JSON.stringify([file, finding.kind, finding.what]);
      const first = found.get(key);
      found.set(key, first === undefined ? { ...finding, copies: 0 } : { ...first, copies: first.copies + 1 });
    }
  }
  const grouped = [...found.values()];
  if (!denies) {
    grouped.push({ kind: 'no-deny', path: join(claudeDir, 'settings.json'), what: 'no settings file has a permissions.deny rule, so nothing is refused outright (secret files, force pushes)', copies: 0 });
  }
  return grouped;
}

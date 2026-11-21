import type { JsonRecord } from '../../core/guards.ts';

/** An answer, or why the settings as they are cannot give it: a problem the core words, never rewrites past. */
export type PermissionsAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

/** What one settings file says of the host's permission rules. */
export interface PermissionsReading {
  /** The allow rules, none when the file has no list; a problem when its list is not one a trim may rewrite. */
  readonly allow: PermissionsAnswer<readonly string[]>;
  /** The deny rules that are texts, none when the file has no deny list. */
  readonly deny: readonly string[];
  /** The setting that lets every tool call run without asking, worded for a person; undefined when none does. */
  readonly bypass: string | undefined;
}

/** A change to the trusted routes, or none when the settings already read this way. */
export interface TrustedRoutesPlan {
  /** The settings to write; undefined when nothing changes. */
  readonly settings: JsonRecord | undefined;
  /** Route lines the change takes out. */
  readonly removed: readonly string[];
  /** Route lines the change puts in. */
  readonly added: readonly string[];
}

/**
 * The host's permission rules: the allow and deny lists a settings file holds, the deny lines that keep a session off
 * the well-known credential homes, and the trusted routes the host's automatic approval reads as facts of the setup.
 * The core reads and writes the settings files; this port only reads their content and says how it changes.
 */
export interface HostPermissions {
  /** The settings names, as a person would look them up in the host's settings. */
  readonly allowSetting: string;
  readonly denySetting: string;
  readonly routesSetting: string;
  read(settings: JsonRecord): PermissionsReading;
  /** The deny lines that keep a session's tools off the credential homes of this platform. */
  denyLines(platform: NodeJS.Platform): readonly string[];
  /** The settings with this allow list in place of the one they hold, every other setting as it was. */
  writeAllow(settings: JsonRecord, allow: readonly string[]): PermissionsAnswer<JsonRecord>;
  /** Puts the lines starting with `tag` in: where its lines were, else after the ones already there. */
  installRoutes(settings: JsonRecord, tag: string, lines: readonly string[]): PermissionsAnswer<TrustedRoutesPlan>;
  /** Takes the lines starting with `tag` out, and leaves every other line as it was. */
  uninstallRoutes(settings: JsonRecord, tag: string): PermissionsAnswer<TrustedRoutesPlan>;
}

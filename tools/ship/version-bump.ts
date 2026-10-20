/**
 * The plugin version a ship sets, worked out from main when the ship holds the host lock (T629): a change
 * raises its base's version by hand, and when main moved on while it waited, the same raise lands on main's.
 */

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Which part of the version a change raised. */
export type BumpKind = 'major' | 'minor' | 'patch';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(text: string): Version {
  const match = VERSION.exec(text);
  if (match === null) throw new Error(`${text}: not a major.minor.patch version`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export const formatVersion = ({ major, minor, patch }: Version): string => `${major}.${minor}.${patch}`;

/** Below zero when a comes first, zero when they are equal, above zero when b comes first. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** How a change raised its base's version; null when it did not raise it. */
export function bumpKindOf(base: Version, set: Version): BumpKind | null {
  if (compareVersions(set, base) <= 0) return null;
  if (set.major !== base.major) return 'major';
  return set.minor !== base.minor ? 'minor' : 'patch';
}

export function bumped(version: Version, kind: BumpKind): Version {
  switch (kind) {
    case 'major':
      return { major: version.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: version.major, minor: version.minor + 1, patch: 0 };
    case 'patch':
      return { ...version, patch: version.patch + 1 };
  }
}

/** A file that carries the plugin version: the pattern's three groups are the text before it, it, and after it. */
export interface VersionFile {
  readonly path: string;
  readonly pattern: RegExp;
}

/** teamrig's two version places, which a test in the repo holds equal (SKILL.md, version bump). */
export const TEAMRIG_VERSION_FILES: readonly VersionFile[] = [
  { path: 'plugins/teamrig/.claude-plugin/plugin.json', pattern: /("version":\s*")(\d+\.\d+\.\d+)(")/ },
  { path: 'src/core/version.ts', pattern: /(KIT_VERSION = ')(\d+\.\d+\.\d+)(')/ },
];

export function versionIn(text: string, file: VersionFile): Version {
  const found = file.pattern.exec(text)?.[2];
  if (found === undefined) throw new Error(`${file.path}: no version matching ${file.pattern.source}`);
  return parseVersion(found);
}

export function withVersion(text: string, file: VersionFile, version: Version): string {
  versionIn(text, file);
  return text.replace(file.pattern, (_match, before: string, _old: string, after: string) => `${before}${formatVersion(version)}${after}`);
}

/** A version written in text, never part of a longer one (0.88.1 is not found in 10.88.1 or 0.88.12). */
export const versionMention = (version: string, flags = ''): RegExp => new RegExp(String.raw`(?<![\d.])${version.replaceAll('.', String.raw`\.`)}(?!\d|\.\d)`, flags);

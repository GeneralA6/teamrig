import { posix, win32 } from 'node:path';

/** Platforms whose default filesystems (NTFS, APFS) ignore case. */
const CASE_INSENSITIVE: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);

/**
 * One key for every spelling of a place: resolved by the platform's rules (separators, `..`, a
 * trailing slash) and lowercased where the default filesystem ignores case, so `C:\Work\` and
 * `c:/work` share a key on Windows. Lowercasing is close to, not exactly, the filesystem's own case
 * folding; ids are lowercase ASCII, so the kit's own paths never differ only beyond it.
 */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = (platform === 'win32' ? win32 : posix).resolve(path);
  return CASE_INSENSITIVE.has(platform) ? resolved.toLowerCase() : resolved;
}

/** Whether two paths name the same place on the platform (see `pathKey`). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** Whether `path` is `folder` or a place inside it, on the platform's rules (see `pathKey`). */
export function isAtOrBelow(path: string, folder: string, platform: NodeJS.Platform = process.platform): boolean {
  const key = pathKey(path, platform);
  const base = pathKey(folder, platform);
  const sep = (platform === 'win32' ? win32 : posix).sep;
  return key === base || key.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * The path as people write it in shared text: `~/` and forward slashes below the user's home folder, so it reads the
 * same on every machine of the same user; the resolved path elsewhere.
 */
export function homeRelative(path: string, userHome: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? win32 : posix;
  const relative = paths.relative(userHome, path);
  if (relative === '') {
    return '~';
  }
  const outside = relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
  return outside ? paths.resolve(path) : `~/${relative.replaceAll('\\', '/')}`;
}

/** The path with a leading `~` (`~/`, or `~\` on Windows) read as the user's home folder; any other path as written. */
export function expandHome(path: string, userHome: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? win32 : posix;
  if (path === '~') {
    return userHome;
  }
  const below = platform === 'win32' ? /^~[\\/]/ : /^~\//;
  return below.test(path) ? paths.join(userHome, path.slice(2)) : path;
}

/** A Claude Code worktree's folder in a path, `<repo>/.claude/worktrees/<name>`, with either separator. */
const CLAUDE_WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/;
const CLAUDE_WORKTREE_ANY_CASE = new RegExp(CLAUDE_WORKTREE.source, 'i');

/**
 * For a path at or below a Claude Code worktree (`<repo>/.claude/worktrees/<name>[/<rest>]`, made by EnterWorktree or
 * `claude --worktree`), the same place in its repo's folder (`<repo>[/<rest>]`): the worktree is a temporary copy of
 * that repo. Undefined for any other path. The folder names match in any case where the filesystem ignores it.
 */
export function claudeWorktreeRepo(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const match = (CASE_INSENSITIVE.has(platform) ? CLAUDE_WORKTREE_ANY_CASE : CLAUDE_WORKTREE).exec(path);
  if (match === null) {
    return undefined;
  }
  const head = path.slice(0, match.index);
  const tail = path.slice(match.index + match[0].length);
  const atRoot = tail === '' && (head === '' || head.endsWith(':'));
  return atRoot ? `${head}${(platform === 'win32' ? win32 : posix).sep}` : `${head}${tail}`;
}

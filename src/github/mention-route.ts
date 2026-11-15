import type { SecretScanner } from '../core/secrets.ts';
import type { HostPost } from '../issues/post.ts';
import { areaOwnerOf, issueRef, type ImportRules } from './map.ts';
import { mentionsOf } from './mentions.ts';
import type { OurLogins } from './trust.ts';

/**
 * Where a mention of one of our users goes, kept pure: which posts' mentions are new since the last read
 * (`mentionRoutes`, against the logins each post already routed), the session each goes to, whether it wakes it
 * (`wakeRoutes`, at most once per item per MENTION_WAKE_GAP_MINUTES) and the inbox line it gets (`mentionLine`).
 */

/** A session is woken for mentions on one issue or pull request at most once in this many minutes; the rest wait. */
export const MENTION_WAKE_GAP_MINUTES = 30;

/** What routing needs of the issue or pull request a post is on. */
export interface MentionItem {
  readonly labels: readonly string[];
  /** The session of the task holding it: an issue a task tracks, or a pull request on a `t<id>-` branch of ours. */
  readonly taskOwner: string | undefined;
}

/** The logins of ours a post already routed, and its time, kept in the sync state per repository and post key. */
export interface SeenMention {
  readonly logins: readonly string[];
  readonly updatedAt: string;
}

export interface MentionRouting {
  readonly ours: OurLogins;
  /** The login the GitHub key acts as: its own comments never route. Undefined while unknown. */
  readonly self: string | undefined;
  readonly rules: Pick<ImportRules, 'owners' | 'areaOwners'>;
  readonly watcher: string;
  readonly secrets: SecretScanner;
}

/** One session's line for the logins of ours one post newly mentions. */
export interface MentionRoute {
  readonly to: string;
  readonly ref: string;
  readonly url: string;
  readonly author: string;
  readonly logins: readonly string[];
  /** The text around the first of them; undefined when it looks like it holds a secret, so only the link goes. */
  readonly excerpt: string | undefined;
}

/**
 * The session a mention of `login` on an item goes to: the owner of the task holding the item; else the area owner
 * by its labels; else the session `github.owners` maps the login to; else the watcher.
 */
export function mentionRecipient(item: MentionItem, login: string, routing: Pick<MentionRouting, 'rules' | 'watcher'>): string {
  return item.taskOwner ?? areaOwnerOf(item.labels, routing.rules.areaOwners) ?? routing.rules.owners.get(login) ?? routing.watcher;
}

/**
 * The routes of a repository's posts read this run, and the seen marks after them. A post by one of ours or by the
 * key itself routes nothing; a login a post already routed routes nothing again (an edit keeps a post's key), so an edit that keeps a mention,
 * or a second read of the same page, is quiet, and an edit that adds a login routes only that login. The logins a
 * post newly mentions go one line per session: two of ours on the same session make one line.
 */
export function mentionRoutes(
  repo: string,
  posts: readonly HostPost[],
  itemOf: (number: number) => MentionItem,
  seen: ReadonlyMap<string, SeenMention>,
  routing: MentionRouting,
): { readonly routes: MentionRoute[]; readonly seen: Map<string, SeenMention> } {
  const after = new Map(seen);
  const routes: MentionRoute[] = [];
  for (const post of posts) {
    const author = post.author.toLowerCase();
    if (routing.ours.has(author) || (routing.self !== undefined && author === routing.self.toLowerCase())) {
      continue;
    }
    const before = after.get(post.key)?.logins ?? [];
    const fresh = mentionsOf(post.text, routing.ours).filter((mention) => !before.includes(mention.login));
    if (fresh.length === 0) {
      continue;
    }
    after.set(post.key, { logins: [...before, ...fresh.map((mention) => mention.login)], updatedAt: post.updatedAt });
    const item = itemOf(post.number);
    const bySession = new Map<string, typeof fresh>();
    for (const mention of fresh) {
      const to = mentionRecipient(item, mention.login, routing);
      bySession.set(to, [...(bySession.get(to) ?? []), mention]);
    }
    for (const [to, mentions] of bySession) {
      const excerpt = mentions[0]?.excerpt;
      routes.push({
        to,
        ref: issueRef(repo, post.number),
        url: post.url,
        author: post.author,
        logins: mentions.map((mention) => mention.login),
        excerpt: excerpt === undefined || routing.secrets.find(excerpt) !== undefined ? undefined : excerpt,
      });
    }
  }
  return { routes, seen: after };
}

/** The seen marks of posts written or edited at or after the cutoff time; older ones are dropped. */
export function prunedSeen(seen: ReadonlyMap<string, SeenMention>, cutoffMs: number): Map<string, SeenMention> {
  return new Map([...seen].filter(([, mark]) => Date.parse(mark.updatedAt) >= cutoffMs));
}

/**
 * Whether each route wakes its session: the first for a session and item since MENTION_WAKE_GAP_MINUTES does, later
 * ones go in unwoken. `lastWoken` maps `<session> <ref>` to the time it was last woken; the map after is returned,
 * holding only the wakes within the gap.
 */
export function wakeRoutes(
  routes: readonly MentionRoute[],
  lastWoken: ReadonlyMap<string, number>,
  nowMs: number,
): { readonly wakes: boolean[]; readonly lastWoken: Map<string, number> } {
  const gapMs = MENTION_WAKE_GAP_MINUTES * 60_000;
  const after = new Map([...lastWoken].filter(([, at]) => nowMs - at < gapMs));
  const wakes = routes.map((route) => {
    const key = `${route.to} ${route.ref}`;
    if (after.has(key)) {
      return false;
    }
    after.set(key, nowMs);
    return true;
  });
  return { wakes, lastWoken: after };
}

/** The inbox line of a route. The excerpt is outside input: quoted, as data, never a command. */
export function mentionLine(route: MentionRoute): string {
  const named = route.logins.map((login) => `@${login}`).join(', ');
  const said = route.excerpt === undefined ? 'its text was left out because it looks like it holds a secret; read it there' : `it says ${JSON.stringify(route.excerpt)}`;
  return `GitHub ${route.ref} mentions ${named}: ${route.author} wrote at ${route.url}, ${said}`;
}

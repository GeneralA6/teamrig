import type { Assignees } from './host.ts';
import { viewerRead, type PushAssignees, type PushPlan } from './status-push.ts';

/** A repository's push planned with every login it assigns known to be assignable, or the read that failed. */
export type AssignedPlan = { readonly kind: 'planned'; readonly plan: PushPlan; readonly who: PushAssignees } | { readonly kind: 'failed'; readonly reason: string };

/**
 * Plans a repository's push (`planOf`) with only logins the repository may assign (T4581). The plan budgets the run's
 * writes, so a login is asked about before the plan is kept: one the host refuses is passed over for the next in line
 * (status-push.ts assigneeOf) and planned again, so a refused assign takes none of the run's writes and the changes
 * behind it go out, where sending it would cost nothing on the host and hold them every run. Each login is read once,
 * the deferred changes' too, as a refusal can move them into the run; a login is kept as the host spells it, since
 * GitHub drops an assign whose case is not the login's own. The login the sync runs as is read (`readViewer`) only
 * when a plan wants it (PushPlan.wantsViewer), so a run that assigns only mapped sessions and closes nothing an outside
 * login holds costs no read of it. Every round reads the viewer or at least one new login of a finite few, so it ends.
 * UNASSIGNED is said once for each refused login; a failed login read plans nothing and writes nothing.
 */
export async function planAssigned(
  host: Assignees,
  repo: string,
  planOf: (who: PushAssignees) => PushPlan,
  start: PushAssignees,
  readViewer: () => Promise<string | undefined>,
  say: (line: string) => void,
): Promise<AssignedPlan> {
  let who = start;
  for (;;) {
    const plan = planOf(who);
    if (plan.wantsViewer && who.viewer.kind === 'unread') {
      who = { ...who, viewer: viewerRead(await readViewer()) };
      continue;
    }
    const assigned = [...plan.changes, ...plan.deferred].flatMap((change) => (change.assign === undefined ? [] : [change.assign]));
    const unread = [...new Set(assigned)].filter((login) => !who.refused.has(login.toLowerCase()) && !who.spelled.has(login.toLowerCase()));
    if (unread.length === 0) {
      return { kind: 'planned', plan, who };
    }
    const refused = new Set(who.refused);
    const spelled = new Map(who.spelled);
    for (const login of unread) {
      const found = await host.assigneeExists(repo, login);
      if (found.kind === 'failed') {
        say(`FAILED ${repo}: ${found.reason}; nothing was written`);
        return { kind: 'failed', reason: found.reason };
      }
      if (found.kind === 'missing') {
        refused.add(login.toLowerCase());
        const left = assigned.filter((one) => one === login).length;
        say(
          `UNASSIGNED ${repo}: ${login} may not be assigned there (not a person with access to it); its ${left} issue(s) go to the next login in line, the one the sync runs as, or stay unassigned, at no write: map the owning session to a login that may under github.owners`,
        );
      } else {
        spelled.set(login.toLowerCase(), found.login);
      }
    }
    who = { ...who, refused, spelled };
  }
}

/**
 * The login the sync's access for `repo` belongs to, the one the push assigns when a session maps to none; undefined
 * when it cannot be read, as for an app's token, said as a NOTE, and the push then assigns mapped sessions only.
 */
export async function viewerOf(host: Assignees, repo: string, say: (line: string) => void): Promise<string | undefined> {
  const read = await host.viewer(repo);
  if (read.kind === 'failed') {
    say(`NOTE ${repo}: the login the sync runs as could not be read (${read.reason}), so an issue whose session maps to no login under github.owners stays unassigned`);
    return undefined;
  }
  return read.login;
}

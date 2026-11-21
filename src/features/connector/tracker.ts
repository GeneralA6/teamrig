import type { ConnectorGroup } from '../feature.ts';

/** What a tracker, the tool holding a team's issues, is asked for. */
export const TRACKER_FEATURES = {
  'tracker.issue-import': { kind: 'tracker', doc: 'a task per open issue, kept in step with it (`issue sync`)', byDefault: 'on' },
  'tracker.accept-label': { kind: 'tracker', doc: "an outsider's issue is taken once one of the team's people labels it accepted", byDefault: 'on' },
  'tracker.watch': { kind: 'tracker', doc: 'a look for changes every few seconds, a sync only after one (`issue watch`)', byDefault: 'on' },
  'tracker.issue-open': { kind: 'tracker', doc: "opening a task's issue with its labels (`add --issue`, `issue migrate`)", byDefault: 'on' },
  'tracker.comment': { kind: 'tracker', doc: 'a comment on an issue (`issue reply`)', byDefault: 'on' },
  'tracker.edit-body': { kind: 'tracker', doc: "rewriting an issue's body (`issue edit-body`)", byDefault: 'on' },
  'tracker.close': { kind: 'tracker', doc: 'closing an issue as completed, not planned or duplicate (`issue close`)', byDefault: 'on' },
  'tracker.labels': { kind: 'tracker', doc: 'adding, removing and making labels (`issue label`)', byDefault: 'on' },
  'tracker.status-push': { kind: 'tracker', doc: 'a status label per active task, its owner as assignee (`issue push`)', byDefault: 'on' },
  'tracker.assign': { kind: 'tracker', doc: 'assigning and unassigning people (`issue assign`)', byDefault: 'on' },
  'tracker.claims': { kind: 'tracker', doc: "a commenter's take line assigns them, and an idle claim is taken off", byDefault: 'on' },
  'tracker.clocks': { kind: 'tracker', doc: 'the response clock: threads waiting on an answer from the team', byDefault: 'on' },
  'tracker.mentions': { kind: 'tracker', doc: "a post naming one of the team's people wakes their session", byDefault: 'on' },
  'tracker.follow': { kind: 'tracker', doc: 'a session hears the changes on an item it follows (`follow`)', byDefault: 'on' },
  'tracker.links': { kind: 'tracker', doc: 'parent and blocker links between issues (`issue links`)', byDefault: 'on' },
  'tracker.fields': { kind: 'tracker', doc: "a task's priority and type written to issue fields", byDefault: 'on' },
  'tracker.similar': { kind: 'tracker', doc: 'finding imported issues alike (`issue similar`)', byDefault: 'on' },
  'tracker.security-alert': { kind: 'tracker', doc: 'a security-labelled issue pages the lead', byDefault: 'on' },
  'tracker.stamp': { kind: 'tracker', doc: 'posted text ends with the made-with-teamrig footer', byDefault: 'on' },
  'tracker.hidden-mark': { kind: 'tracker', doc: 'a mark on an issue that its readers do not see', byDefault: 'on' },
} as const satisfies ConnectorGroup<'tracker'>;

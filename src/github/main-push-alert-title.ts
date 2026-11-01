/**
 * The title of the issue the main-push alert workflow opens (tools/ci/main-push-alert.ts) when main changes outside a
 * pull request. The sync trusts an issue the repository's own Actions bot opened only under this title (trust.ts), so
 * the alert and the sync both read it from here.
 */
const ALERT_TITLE = /^(?:Force push|Push) to main outside a pull request, by .+$/;

/** The alert's title for a push by `pusher`, a force push when `forced`. */
export function mainPushAlertTitle(forced: boolean, pusher: string): string {
  return `${forced ? 'Force push' : 'Push'} to main outside a pull request, by ${pusher}`;
}

/** Whether `title` is one the main-push alert gives its issue. */
export function isMainPushAlertTitle(title: string): boolean {
  return ALERT_TITLE.test(title);
}

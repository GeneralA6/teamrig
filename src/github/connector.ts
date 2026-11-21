import type { Connector } from '../interface/connector.ts';
import { targetText } from '../issues/host.ts';
import { refTarget } from '../issues/links.ts';
import { GITHUB_SOURCE } from '../register/model.ts';

/**
 * GitHub as the public interface's documents name it. Its id is the source the issue import writes, so an imported
 * task's source and its ref name the same connector. A pull request's ref gets the issue page too: the host sends
 * that address on to the pull request, so the ref needs no call to learn which of the two it is.
 */
export const GITHUB_CONNECTOR: Connector = {
  id: GITHUB_SOURCE,
  name: 'GitHub',
  itemOf(ref) {
    const target = refTarget({ ref });
    return target === undefined ? undefined : { id: targetText(target), url: issuePage(target.repo, target.number) };
  },
};

/**
 * An issue's page on GitHub, built from its repository and number. Every address teamrig keeps or serves for an
 * issue is this one, never the string GitHub's API sent: that string is outside text, and a kept field is served
 * as the team's own.
 */
export function issuePage(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

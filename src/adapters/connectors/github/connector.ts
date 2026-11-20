import { issuePage, parseRef, targetText, type Connector } from '../../../plugin-api/index.ts';
import { declaration } from './declaration.ts';

/**
 * GitHub as the public interface's documents name it. Its id is the adapter's, which is also the source the issue
 * import writes, so an imported task's source and its ref name the same connector. A pull request's ref gets the
 * issue page too: the host sends that address on to the pull request, so the ref needs no call to learn which of the
 * two it is.
 */
export const GITHUB_CONNECTOR: Connector = {
  id: declaration.id,
  name: declaration.name,
  itemOf(ref) {
    const target = parseRef(ref);
    return target === undefined ? undefined : { id: targetText(target), url: issuePage(target.repo, target.number) };
  },
};

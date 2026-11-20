/**
 * How much one mention scan reads of a repository. The read keeps to these numbers and the scan's cut-off line says
 * them, so both take them from here.
 */

/** The page size of a mention list and of a pull request's reviews: GitHub's largest. */
export const MENTION_PAGE_SIZE = 100;

/** The most pages of one list the scan reads in a run; past it, the rest is cut off and said so. */
export const MENTION_PAGES_MAX = 10;

/** The most pull requests whose reviews one read takes; past it, the rest wait for the next read. */
export const REVIEW_READS_MAX = 20;

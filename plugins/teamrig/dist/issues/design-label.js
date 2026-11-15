/**
 * The label of a design issue: talk about how something should work, where every contributor and their agent may
 * give their side, and nothing to take or build until the maintainers mark it agreed. It replaces a discussion
 * forum, so the talk stays beside the work it leads to. Such an issue carries no status label: there is no work on
 * it to show the state of.
 */
export const DESIGN_LABEL = 'design';
/** The design label as teamrig makes it in a repository that lacks it; the colour reads on light and dark alike. */
export const DESIGN_LABEL_SPEC = {
    name: DESIGN_LABEL,
    color: 'd4c5f9',
    description: 'Design talk: discussion only, not work to take until it is agreed',
};

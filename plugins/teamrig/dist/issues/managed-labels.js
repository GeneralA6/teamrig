import { DESIGN_LABEL_SPEC } from "./design-label.js";
import { STATUS_LABEL_SPECS } from "./status-push.js";
/**
 * Every label teamrig makes in a repository that lacks it: the status push's five and the design label. github/gh.ts
 * allows the create of these and no other, word for word, so teamrig never makes a label the docs do not name.
 */
export const MANAGED_LABEL_SPECS = [...STATUS_LABEL_SPECS, DESIGN_LABEL_SPEC];
/** The spec teamrig makes `name` with, or undefined for a label teamrig does not manage. */
export function managedLabel(name) {
    return MANAGED_LABEL_SPECS.find((spec) => spec.name === name);
}

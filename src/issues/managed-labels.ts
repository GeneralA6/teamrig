import { DESIGN_LABEL_SPEC } from './design-label.ts';
import type { LabelSpec } from './host.ts';
import { STATUS_LABEL_SPECS } from './status-push.ts';

/**
 * Every label teamrig makes in a repository that lacks it: the status push's five and the design label. github/gh.ts
 * allows the create of these and no other, word for word, so teamrig never makes a label the docs do not name.
 */
export const MANAGED_LABEL_SPECS: readonly LabelSpec[] = [...STATUS_LABEL_SPECS, DESIGN_LABEL_SPEC];

/** The spec teamrig makes `name` with, or undefined for a label teamrig does not manage. */
export function managedLabel(name: string): LabelSpec | undefined {
  return MANAGED_LABEL_SPECS.find((spec) => spec.name === name);
}

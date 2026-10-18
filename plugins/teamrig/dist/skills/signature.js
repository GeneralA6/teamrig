/**
 * A skill's signature: the procedure it holds, done by hand, as regexes over one tool call's `<tool name> <command>`
 * (e.g. `Bash teamrig inbox read`). Each is a body line ``Signature: `<regex>` ``, kept in the skill itself so a new
 * skill brings its own. The skills scorecard counts a call that matches one, with no load of the skill shortly
 * before, as a missed use of the skill.
 */
const SIGNATURE_LINE = /^Signature:\s*`([^`]+)`\s*$/gm;
/** The skill's `Signature:` lines, each compiled; none when it has no such line. */
export function signatureOf(skill) {
    const patterns = [];
    const invalid = [];
    for (const match of skill.text.matchAll(SIGNATURE_LINE)) {
        const source = match[1] ?? '';
        try {
            patterns.push(new RegExp(source));
        }
        catch {
            invalid.push(source);
        }
    }
    return { name: skill.name, patterns, invalid };
}

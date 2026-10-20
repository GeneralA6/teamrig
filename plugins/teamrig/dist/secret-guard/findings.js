/** What the call would print, as the refusal names it. */
export function describeFinding(finding) {
    switch (finding.kind) {
        case 'file':
            return `the content of ${finding.path}`;
        case 'environment':
            return 'the whole environment';
        case 'variable':
            return `the value of $${finding.name}`;
        case 'kube-secret':
            return "a Kubernetes secret's data";
    }
}
/** `findings` without repeats, in order. */
export function uniqueFindings(findings) {
    const seen = new Set();
    return findings.filter((finding) => {
        const key = describeFinding(finding);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

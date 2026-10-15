import { programName } from "./launchers.js";
/** A redirection of stdout: `>`, `>>`, `>|`, `1>`, or a copy such as `>&2`. */
const STDOUT = /^1?>/;
/** A redirection that writes stdout to the file it names. */
const FILE_WRITE = /^1?>[>|]?$/;
/** A path into a device or process folder, such as `/dev/stdout` or `/proc/self/fd/1`, which may lead back to a pipe. */
const DEVICE = /(?:^|[\\/])(?:dev|proc)(?:[\\/]|$)/i;
/** A pipe to the next command, maybe after the newline that ends a heredoc's line. */
const PIPE = /^\|&?\n*$/;
/** True when a launch is `cat` with no arguments but `-`, so its stdin is all it writes. */
function plainCat(launched) {
    return (launched.kind === 'program' &&
        !launched.program.dynamic &&
        programName(launched.program.text) === 'cat' &&
        !launched.stdinArgs &&
        launched.args.every((arg) => !arg.dynamic && arg.text === '-'));
}
/** What `command`, which starts `launched`, does with what it reads on stdin; see {@link StdinUse}. */
export function stdinUse(command, launched) {
    if (!plainCat(launched)) {
        return 'read';
    }
    const output = command.redirections.findLast((redirection) => STDOUT.test(redirection.operator));
    if (output === undefined) {
        return PIPE.test(command.terminator) ? 'passed' : 'read';
    }
    const file = output.target;
    return FILE_WRITE.test(output.operator) && file !== undefined && !file.dynamic && !DEVICE.test(file.text) ? 'stored' : 'read';
}

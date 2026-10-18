/** The choice a key makes: Enter starts now, `i` reopens idle, `q`, Escape or Ctrl+C cancels; any other none. */
export function keyChoice(key) {
    if (key === '\r' || key === '\n') {
        return 'go';
    }
    const lower = key.toLowerCase();
    if (lower === 'i') {
        return 'idle';
    }
    return lower === 'q' || key === '\u0003' || key === '\u001b' ? 'cancel' : undefined;
}
/** The countdown's line, redrawn in place each second. */
export function countdownLine(remaining) {
    return `\rStarting in ${String(remaining).padStart(2)}s   [Enter] start now   [i] reopen all with no prompt   [q] cancel `;
}
export function terminalCountdown(terminal) {
    return {
        choose(seconds) {
            return new Promise((resolve) => {
                let remaining = seconds;
                let done = false;
                const stops = [];
                const finish = (choice) => {
                    if (done) {
                        return;
                    }
                    done = true;
                    stops.forEach((stop) => stop());
                    terminal.write('\n');
                    resolve(choice);
                };
                terminal.write(countdownLine(remaining));
                stops.push(terminal.listen((key) => {
                    const choice = keyChoice(key);
                    if (choice !== undefined) {
                        finish(choice);
                    }
                }));
                stops.push(terminal.everySecond(() => {
                    remaining -= 1;
                    if (remaining <= 0) {
                        finish('go');
                    }
                    else {
                        terminal.write(countdownLine(remaining));
                    }
                }));
            });
        },
    };
}
/** The process's own terminal: keys from stdin in raw mode, when it is one, and the line on stdout. */
export function stdioCountdownTerminal(input, output) {
    return {
        write(text) {
            output.write(text);
        },
        listen(onKey) {
            if (!input.isTTY) {
                return () => undefined;
            }
            const onData = (chunk) => onKey(String(chunk));
            input.setRawMode(true);
            input.resume();
            input.on('data', onData);
            return () => {
                input.removeListener('data', onData);
                input.setRawMode(false);
                input.pause();
            };
        },
        everySecond(tick) {
            const timer = setInterval(tick, 1000);
            return () => clearInterval(timer);
        },
    };
}

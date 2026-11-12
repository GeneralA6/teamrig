import { KIT_NAME } from "../core/home.js";
import { powerShellRequest } from "../core/powershell.js";
import { MS_PER_MINUTE } from "../core/time.js";
/**
 * A missed meeting's toast stays a minute, the longest Claude Code shows one: its `ui.toast` drops a toast whose
 * timeoutMs is over 60 000 ms (the engine's host check), so a longer stay would show nothing.
 */
export const MISSED_STAY_MS = 60_000;
/** Who meets: the session, then any others it meets with. */
function whoOf(meeting) {
    return meeting.with.length === 0 ? meeting.session : `${meeting.session} with ${meeting.with.join(', ')}`;
}
/** The notice of `meeting` at `stage`, worded as of `now` (a `before` notice counts the minutes left, rounded up). */
export function noticeOf(meeting, stage, now) {
    const start = `${KIT_NAME} meeting start ${meeting.id}`;
    const line = `${whoOf(meeting)}: ${meeting.about} (${meeting.minutes} min)`;
    switch (stage) {
        case 'before': {
            const minutes = Math.max(1, Math.ceil((meeting.at - now) / MS_PER_MINUTE));
            return { id: meeting.id, stage, title: `${KIT_NAME} meeting ${meeting.id} in ${minutes} min`, text: `${line}. Start: ${start}`, stayMs: null };
        }
        case 'start':
            return { id: meeting.id, stage, title: `${KIT_NAME} meeting ${meeting.id} now`, text: `${line}. Start: ${start}`, stayMs: null };
        case 'missed':
            return {
                id: meeting.id,
                stage,
                title: `${KIT_NAME} meeting ${meeting.id} missed`,
                text: `${line} has not started. Start: ${start}, or move or drop it`,
                stayMs: MISSED_STAY_MS,
            };
    }
}
/** The variables the Windows toast script reads its words from. */
export const NOTICE_TITLE_VAR = 'TEAMRIG_NOTICE_TITLE';
export const NOTICE_TEXT_VAR = 'TEAMRIG_NOTICE_TEXT';
/** Windows PowerShell's own app id: a toast shown under it needs no app of teamrig's registered. */
export const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
/** A WinRT toast from Windows PowerShell 5.1, no package needed; CreateTextNode escapes the words it is given. */
export const WINDOWS_TOAST_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '$toast = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$toast.DocumentElement.SetAttribute('duration', 'long')",
    "$texts = $toast.GetElementsByTagName('text')",
    `[void]$texts.Item(0).AppendChild($toast.CreateTextNode($env:${NOTICE_TITLE_VAR}))`,
    `[void]$texts.Item(1).AppendChild($toast.CreateTextNode($env:${NOTICE_TEXT_VAR}))`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($toast))`,
].join('\n');
/** The macOS banner: the words are the script's run arguments. */
const MAC_NOTICE_SCRIPT = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'];
/** The program that shows `notice` on `platform`, run hidden in `cwd`; undefined where teamrig knows none. */
export function noticeRequest(platform, notice, env, cwd) {
    switch (platform) {
        case 'win32': {
            const { program, args } = powerShellRequest(WINDOWS_TOAST_SCRIPT);
            // Windows PowerShell started with no console runs nothing (T2517).
            return { command: program, args, cwd, env: { ...env, [NOTICE_TITLE_VAR]: notice.title, [NOTICE_TEXT_VAR]: notice.text }, needsConsole: true };
        }
        case 'darwin':
            return { command: 'osascript', args: [...MAC_NOTICE_SCRIPT.flatMap((line) => ['-e', line]), notice.title, notice.text], cwd, env };
        case 'linux':
            return { command: 'notify-send', args: [`--app-name=${KIT_NAME}`, '--', notice.title, notice.text], cwd, env };
        default:
            return undefined;
    }
}
/** Starts the OS notification of `notice`, hidden; never waits for it to show. */
export async function showNotice(processes, platform, notice, env, cwd) {
    const request = noticeRequest(platform, notice, env, cwd);
    return request === undefined ? { kind: 'unsupported' } : processes.startHidden(request);
}

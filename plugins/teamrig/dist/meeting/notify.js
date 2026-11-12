import { KIT_NAME } from "../core/home.js";
import { powerShellRequest } from "../core/powershell.js";
export function noticeOf(meeting) {
    return {
        id: meeting.id,
        title: `${KIT_NAME} meeting ${meeting.id} now`,
        text: `${meeting.session}: ${meeting.about} (${meeting.minutes} min). Start: ${KIT_NAME} meeting start ${meeting.id}`,
    };
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

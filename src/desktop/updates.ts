import { ipcMain, Notification, shell } from "electron";
import { CHANNELS } from "./channels";
import { releaseChecker } from "./release-check";

/**
 * Tells the user a newer release exists. The app installs nothing: a new release is a new download (or
 * `flatpak update` for the Flatpak, once its repository is added), so the job here is only to say so.
 *
 * The page asks through the bridge (Settings > About shows it). On top of that the app looks on its own a few
 * seconds after launch and every six hours, and shows one system notification per release per run; clicking
 * it opens the release page. A failed look says nothing: the app works the same without it.
 */

const FIRST_LOOK_MS = 10_000;
const EVERY_MS = 6 * 60 * 60_000;

export function startUpdateChecks(version: string, icon: string): void {
    const check = releaseChecker(version);
    ipcMain.handle(CHANNELS.checkForUpdate, () => check());

    let told: string | undefined;
    const look = async (): Promise<void> => {
        const answer = await check();
        if (answer.state !== "available" || told === answer.latest || !Notification.isSupported()) return;
        told = answer.latest;
        const note = new Notification({
            title: `PiKVM Desktop ${answer.latest} is out`,
            body: `You have ${version}. Click to open the release page.`,
            icon,
        });
        note.on("click", () => void shell.openExternal(answer.url));
        note.show();
    };
    setTimeout(() => void look(), FIRST_LOOK_MS).unref();
    setInterval(() => void look(), EVERY_MS).unref();
}

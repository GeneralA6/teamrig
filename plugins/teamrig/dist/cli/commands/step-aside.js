import { busyText, holderText, waitText } from "../../delivery/host-lock.js";
import { deliveryPlaces } from "../../delivery/places.js";
import { ENV } from "../../core/home.js";
import { UsageError } from "../args.js";
import { hostLockOf, logLineOf, teamAdmissionOf } from "../delivery-ports.js";
import { openTeamKit, reloadTeamConfig, requireConfig, teamZone } from "../kit.js";
import { EXIT } from "../runtime.js";
const MINUTE_MS = 60_000;
/** The id of the host share the queued step running this command holds (`$TEAMRIG_HOST_LOCK`); refused outside a queued step. */
function heldIdOf(runtime, command) {
    const id = runtime.env[ENV.hostLock]?.trim();
    if (id === undefined || id === '') {
        throw new UsageError(`${command} runs only inside a queued step (teamrig queue), whose $${ENV.hostLock} names the host share it holds`);
    }
    return id;
}
async function openLock(runtime) {
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const zone = teamZone(config, runtime);
    const { delivery } = config;
    const lock = hostLockOf(runtime, deliveryPlaces(delivery, kit.paths).hostLock, delivery.queue, config.open.headroom, teamAdmissionOf(config, () => reloadTeamConfig(runtime, kit)), zone);
    return { lock, zone, waitMs: delivery.queue.waitMinutes * MINUTE_MS, pollMs: delivery.wait.pollSeconds * 1_000 };
}
/**
 * `teamrig step-away`: run by a queued step while it only waits on a remote service (a merge waiting on its pull
 * request's checks), it sets the step's host share aside, so the ship slot, its heavy place and its MB go to the next
 * step in line; `teamrig step-back` takes them back in turn. Exit 0 set aside; 1 when the step holds the whole host
 * (the lock file) or an older teamrig's share, which it keeps, or holds nothing; 64 (usage) refused outside a queued step.
 */
export async function stepAway(_args, runtime) {
    const id = heldIdOf(runtime, 'step-away');
    const { lock, zone } = await openLock(runtime);
    const aside = await lock.setAside(id);
    switch (aside.kind) {
        case 'aside':
            runtime.out.stdout(`AWAY ${aside.share.purpose}: its host share (${aside.share.reserveMb} MB) goes to the next step in line until teamrig step-back takes it back in turn`);
            return EXIT.ok;
        case 'whole':
            runtime.out.stdout(`KEPT ${holderText({ kind: 'held', info: aside.lock }, zone)}: it holds the whole host (the lock file), which it keeps`);
            return EXIT.failed;
        case 'olderKit':
            runtime.out.stdout(`KEPT ${aside.share.purpose}: its host share was taken by teamrig ${aside.share.kit ?? 'older than 0.448.0'}, whose release would leave a share set aside behind, so the step keeps it`);
            return EXIT.failed;
        case 'none':
            runtime.out.stdout(`NONE no live host share or lock has the id ${id}: nothing set aside`);
            return EXIT.failed;
    }
}
/**
 * `teamrig step-back`: takes back in its turn the host share its queued step set aside (`teamrig step-away`), at the
 * place of its first taking, waiting as `teamrig queue` does and printing each new reason once. Exit 0 taken back, or
 * nothing set aside; 1 when its wait ran out or it was withdrawn (`teamrig withdraw`); 64 (usage) refused outside a
 * queued step.
 */
export async function stepBack(_args, runtime) {
    const id = heldIdOf(runtime, 'step-back');
    const { lock, zone, waitMs, pollMs } = await openLock(runtime);
    const say = logLineOf(runtime, zone);
    const back = await lock.takeBack(id, waitMs, pollMs, (holder, ahead) => say(`waiting to take back its host share: ${waitText(holder, ahead, zone)}`));
    switch (back.kind) {
        case 'taken':
            runtime.out.stdout(`BACK ${back.lock.purpose}: its host share is taken back`);
            return EXIT.ok;
        case 'none':
            runtime.out.stdout(`NONE no host share of ${id} is set aside: the step holds what it held`);
            return EXIT.ok;
        case 'busy':
            runtime.out.stdout(`GAVE UP ${busyText(back.holder, zone)}`);
            return EXIT.failed;
        case 'withdrawn':
            runtime.out.stdout("WITHDRAWN from the host lock's line (teamrig withdraw): its host share stays set aside");
            return EXIT.failed;
    }
}

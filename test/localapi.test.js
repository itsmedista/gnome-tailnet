// Run: gjs -m test/localapi.test.js
// Integration check against the running tailscaled. Changes nothing: reads status, accounts and waiting Taildrop
// files, sends an empty prefs PATCH (exercises the write path and operator permission), waits for one event.
import GLib from 'gi://GLib';
import System from 'system';
import {LocalApi} from '../localapi.js';

const loop = new GLib.MainLoop(null, false);
const api = new LocalApi();
let failure = null;

(async () => {
    const status = await api.status();
    if (!status.BackendState)
        throw new Error('status has no BackendState');
    await api.setPrefs({});
    const [profiles, current, waiting] = await Promise.all([api.profiles(), api.currentProfile(), api.waitingFiles()]);
    if (!Array.isArray(profiles) || !profiles.some(p => p.ID === current.ID))
        throw new Error('current profile missing from profile list');
    if (!Array.isArray(waiting))
        throw new Error('waitingFiles did not return a list');
    const first = await new Promise((resolve, reject) => api.watch(resolve, reject));
    if (!('State' in first))
        throw new Error(`first watch message has no State: ${Object.keys(first)}`);
    print(`localapi ok: state=${status.BackendState} peers=${Object.keys(status.Peer ?? {}).length} watchState=${first.State} profiles=${profiles.length} waitingFiles=${waiting.length}`);
})().catch(e => {
    failure = e;
}).finally(() => {
    api.destroy();
    loop.quit();
});

loop.run();
if (failure) {
    printerr(failure);
    System.exit(1);
}

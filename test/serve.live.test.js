// Run: gjs -m test/serve.live.test.js
// CHANGES LIVE STATE for ~1 second: shares a dummy tailnet-only service (proxy to 127.0.0.1:9), reads it back,
// removes it and checks the serve config is back to what it was. Never touches Funnel.
import GLib from 'gi://GLib';
import System from 'system';
import {LocalApi} from '../localapi.js';
import {addService, listServices, removeService} from '../model.js';

const loop = new GLib.MainLoop(null, false);
const api = new LocalApi();
let failure = null;

(async () => {
    const status = await api.status();
    const host = status.Self.DNSName.replace(/\.$/, '');
    const before = JSON.stringify((await api.serveConfig()).config);
    const {url} = await api.updateServeConfig(c => addService(c, host, 'http://127.0.0.1:9'));
    const added = listServices((await api.serveConfig()).config).find(s => s.url === url);
    const hostPort = added?.hostPort;
    if (hostPort)
        await api.updateServeConfig(c => ({config: removeService(c, hostPort)}));
    const after = JSON.stringify((await api.serveConfig()).config);
    if (!added || added.target !== 'http://127.0.0.1:9' || added.funnel)
        throw new Error(`service not read back correctly: ${JSON.stringify(added)}`);
    if (after !== before)
        throw new Error(`serve config not restored: before=${before} after=${after}`);
    print(`serve live ok: added and removed ${url}; config restored to ${after}`);
})().catch(e => (failure = e)).finally(() => {
    api.destroy();
    loop.quit();
});
loop.run();
if (failure) {
    printerr(failure);
    System.exit(1);
}

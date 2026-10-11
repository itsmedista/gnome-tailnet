// Run: gjs -m test/model.test.js
import {
    accountLabel, addService, ago, buildAccounts, buildModel, filterPeers, flag, listServices, makeTailnetOnly,
    normalizeLoginServer, normalizeServeTarget, numberedName, removeService, safeFileName, sharingAccess,
} from '../model.js';

const assert = (cond, msg) => {
    if (!cond)
        throw new Error(`FAIL: ${msg}`);
};
const eq = (actual, expected, msg) => assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const now = Date.parse('2026-10-11T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const peer = (id, extra) => ({ID: id, DNSName: `${id}.tail.ts.net.`, TailscaleIPs: [`fd7a::${id.length}`, `100.64.0.${id.length}`], OS: 'linux', Online: true, ...extra});
const mullvad = (id, Country, CountryCode, City, Priority) =>
    peer(id, {ExitNodeOption: true, Location: {Country, CountryCode, City, Priority}});

const status = {
    BackendState: 'Running',
    Health: ['Tailscale is stopped.', 'DNS is misconfigured'],
    CurrentTailnet: {Name: 'me@example.com'},
    Self: peer('laptop', {KeyExpiry: new Date(now + 3 * day - 1000).toISOString()}),
    Peer: {
        a: peer('server', {CurAddr: '1.2.3.4:41641', Active: true}),
        b: peer('phone', {Active: true, Relay: 'sea', TaildropTarget: 1}),
        c: peer('nas', {Active: false, Relay: 'sea'}),
        d: peer('desktop', {Online: false, LastSeen: new Date(now - 2 * day).toISOString()}),
        e: peer('gateway', {ExitNodeOption: true, ExitNode: true}),
        m1: mullvad('de-fra', 'Germany', 'DE', 'Frankfurt', 10),
        m2: mullvad('de-ber', 'Germany', 'DE', 'Berlin', 50),
        m3: mullvad('se-sto', 'Sweden', 'SE', 'Stockholm', 1),
    },
};

const m = buildModel(status, now);
eq(m.peers.map(p => p.name), ['laptop', 'gateway', 'nas', 'phone', 'server', 'desktop'], 'self first, online before offline, Mullvad excluded');
eq(m.peers.map(p => p.connection), ['this device', 'idle', 'idle', 'relay (sea)', 'direct', 'last seen 2d ago'], 'connection labels');
eq(m.peers[1].ip, '100.64.0.7', 'IPv4 preferred over IPv6');
eq(m.peers[0].dnsName, 'laptop.tail.ts.net', 'trailing dot stripped');
eq(m.subtitle, 'via gateway', 'subtitle names current exit node');
eq(m.exitNodes.tailnet, [{id: 'gateway', label: 'gateway', online: true, selected: true}], 'tailnet exit nodes');
eq(m.exitNodes.countries.map(c => [c.id, c.label]), [['de-ber', '🇩🇪 Germany'], ['se-sto', '🇸🇪 Sweden']], 'one Mullvad entry per country, highest priority, sorted');
eq(m.warnings, ['DNS is misconfigured', 'Device key expires in 3 days.'], 'health minus stopped noise, plus key expiry');
eq(m.tailnet, 'me@example.com', 'tailnet name');

// Selecting any city in a country checks that country's entry.
const viaBerlin = buildModel({...status, Peer: {...status.Peer, e: {...status.Peer.e, ExitNode: false}, m1: {...status.Peer.m1, ExitNode: true}}}, now);
assert(viaBerlin.exitNodes.countries[0].selected, 'country selected when one of its cities is the exit node');
eq(viaBerlin.subtitle, 'via 🇩🇪 Frankfurt', 'Mullvad subtitle uses the city');

const stopped = buildModel({...status, BackendState: 'Stopped'}, now);
eq(stopped.subtitle, null, 'no subtitle when stopped');
eq(stopped.warnings, ['Device key expires in 3 days.'], 'stale health hidden while stopped, key expiry kept');
eq(stopped.peers[3].connection, 'online', 'no path claims while stopped');

eq(buildModel({...status, Self: {...status.Self, KeyExpiry: new Date(now - day).toISOString()}}, now).warnings.at(-1),
    'Device key expired. Re-authenticate this device in the Tailscale admin console.', 'expired key');
eq(buildModel({BackendState: 'NeedsLogin'}, now).needsLogin, true, 'login state, empty status tolerated');

eq(filterPeers(m.peers, ' PHONE ').map(p => p.name), ['phone'], 'search by name, trimmed, case-insensitive');
eq(filterPeers(m.peers, '100.64.0.6').map(p => p.name), ['laptop', 'server'], 'search by IP');
eq(filterPeers(m.peers, '').length, m.peers.length, 'empty query keeps all');

eq(flag('de'), '🇩🇪', 'flag');
eq(flag(''), '', 'no flag for bad code');
eq(ago('0001-01-01T00:00:00Z', now), '', 'Go zero time is not a date');
eq(ago(new Date(now - 5 * 60000).toISOString(), now), '5m ago', 'minutes');

eq(m.peers.filter(p => p.taildrop).map(p => p.name), ['phone'], 'only TaildropTarget=1 can receive files');

const throws = (fn, msg) => {
    try {
        fn();
    } catch {
        return;
    }
    throw new Error(`FAIL: ${msg}: did not throw`);
};

const tsAccount = {ID: 'a1', UserProfile: {LoginName: 'me@example.com'}, ControlURL: 'https://controlplane.tailscale.com'};
const hsAccount = {ID: 'b2', UserProfile: {LoginName: 'me@example.com'}, ControlURL: 'https://HS.example.org:8443/'};
eq(accountLabel(tsAccount), 'me@example.com', 'default server not shown');
eq(accountLabel(hsAccount), 'me@example.com · hs.example.org', 'custom server shown');
eq(accountLabel({ID: ''}), 'New account', 'empty profile');
eq(buildAccounts([tsAccount, hsAccount], hsAccount).map(a => [a.id, a.selected]), [['a1', false], ['b2', true]], 'current account selected');
eq(buildAccounts(null, null), [], 'no profiles');

eq(normalizeLoginServer('  '), '', 'blank means Tailscale');
eq(normalizeLoginServer(' https://hs.example.org/ '), 'https://hs.example.org', 'trimmed, trailing slash dropped');
eq(normalizeLoginServer('http://10.0.0.5:8080/hs'), 'http://10.0.0.5:8080/hs', 'http, port and path allowed');
throws(() => normalizeLoginServer('hs.example.org'), 'scheme required');
throws(() => normalizeLoginServer('ftp://hs.example.org'), 'only http(s)');
throws(() => normalizeLoginServer('https://hs.example.org/?x=1'), 'no query');

eq(safeFileName('../../.bashrc'), '.bashrc', 'path traversal stripped');
eq(safeFileName('dir\\evil.exe'), 'evil.exe', 'windows separators stripped');
eq(safeFileName('..'), null, 'dot-dot rejected');
eq(safeFileName(''), null, 'empty rejected');
eq(safeFileName('a\nb.txt'), 'ab.txt', 'control characters removed');

eq(numberedName('photo.jpg', 0), 'photo.jpg', 'first try keeps name');
eq(numberedName('photo.jpg', 2), 'photo (2).jpg', 'number before extension');
eq(numberedName('.bashrc', 1), '.bashrc (1)', 'dotfile has no extension');
eq(numberedName('README', 1), 'README (1)', 'no extension');

// ---- Serve / Funnel
const host = 'laptop.tail.ts.net';
const caps = keys => ({CapMap: Object.fromEntries(keys.map(k => [k, null]))});
eq(sharingAccess(caps(['https', 'funnel', 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000'])),
    {https: true, funnelPorts: [443, 8443, 10000]}, 'full access');
eq(sharingAccess(caps(['https', 'https://tailscale.com/cap/funnel-ports?ports=443'])), {https: true, funnelPorts: []}, 'no funnel attr');
eq(sharingAccess(caps(['funnel', 'https://tailscale.com/cap/funnel-ports?ports=443'])), {https: false, funnelPorts: []}, 'no https');
eq(sharingAccess(undefined), {https: false, funnelPorts: []}, 'no self');

eq(normalizeServeTarget(' 3000 '), 'http://127.0.0.1:3000', 'bare port');
eq(normalizeServeTarget('localhost:8080'), 'http://localhost:8080', 'host:port');
eq(normalizeServeTarget('https://192.168.1.10:8443/app'), 'https://192.168.1.10:8443/app', 'full URL');
throws(() => normalizeServeTarget('70000'), 'port range');
throws(() => normalizeServeTarget('/etc'), 'paths are not proxied');
throws(() => normalizeServeTarget('ftp://x:21'), 'only http(s)');

const original = {TCP: {22: {TCPForward: '127.0.0.1:22'}}};
const frozen = JSON.stringify(original);
const first = addService(original, host, 'http://127.0.0.1:3000');
eq(JSON.stringify(original), frozen, 'input config not mutated');
eq(first.url, 'https://laptop.tail.ts.net/', 'first service on 443 has no port in URL');
eq(first.config.TCP[443], {HTTPS: true}, 'TCP 443 handled as HTTPS');
eq(first.config.TCP[22], {TCPForward: '127.0.0.1:22'}, 'unrelated TCP forward kept');
const second = addService(first.config, host, 'http://127.0.0.1:4000', {funnel: true, funnelPorts: [443, 8443, 10000]});
eq(second.url, 'https://laptop.tail.ts.net:8443/', 'second service takes the next port');
eq(second.config.AllowFunnel, {'laptop.tail.ts.net:8443': true}, 'funnel only on the new service');
eq(listServices(second.config), [
    {hostPort: 'laptop.tail.ts.net:443', url: 'https://laptop.tail.ts.net/', target: 'http://127.0.0.1:3000', funnel: false},
    {hostPort: 'laptop.tail.ts.net:8443', url: 'https://laptop.tail.ts.net:8443/', target: 'http://127.0.0.1:4000', funnel: true},
], 'services listed');
throws(() => addService(second.config, host, 'http://x:1', {funnel: true, funnelPorts: [443, 8443]}), 'no free funnel port');
const third = addService(second.config, host, 'http://127.0.0.1:5000');
throws(() => addService(third.config, host, 'http://x:1'), 'all three ports used');

eq(makeTailnetOnly(second.config, 'laptop.tail.ts.net:8443').AllowFunnel, undefined, 'funnel removed, empty map pruned');
const removed = removeService(second.config, 'laptop.tail.ts.net:8443');
eq(Object.keys(removed.Web), ['laptop.tail.ts.net:443'], 'only that service removed');
eq(Object.keys(removed.TCP).sort(), ['22', '443'], 'its TCP port freed, others kept');
eq(removed.AllowFunnel, undefined, 'its funnel flag removed');
eq(removeService(removeService(second.config, 'laptop.tail.ts.net:8443'), 'laptop.tail.ts.net:443'), original, 'back to the start');
eq(listServices(null), [], 'no serve config');
eq(listServices({TCP: {80: {HTTP: true}}, Web: {'h:80': {Handlers: {'/': {Text: 'hi'}}}}})[0].url, 'http://h/', 'plain HTTP on 80, text handler');

print('model tests passed');

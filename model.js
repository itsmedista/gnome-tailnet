// Turns LocalAPI /status JSON into what the menu shows.
// Pure (no gi:// imports) so test/model.test.js runs in plain gjs.

const KEY_EXPIRY_WARN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const STOPPED_HEALTH = 'Tailscale is stopped.';
const TAILDROP_AVAILABLE = 1; // ipnstate.TaildropTargetAvailable
const DEFAULT_CONTROL_HOSTS = ['controlplane.tailscale.com', 'login.tailscale.com'];

const SUBTITLES = {
    NeedsLogin: 'Needs login',
    NeedsMachineAuth: 'Waiting for approval',
    Starting: 'Connecting…',
    NoState: 'Starting…',
};

export function buildModel(status, now = Date.now()) {
    const state = status.BackendState;
    const running = state === 'Running';
    const all = Object.values(status.Peer ?? {});
    const exitPeer = all.find(p => p.ExitNode);
    const exitNodeLabel = exitPeer ? exitLabel(exitPeer) : null;
    const self = status.Self ? {...toPeer(status.Self, running, now), connection: 'this device'} : null;
    const others = all.filter(p => !isLocationNode(p)).map(p => toPeer(p, running, now)).sort(byOnlineThenName);

    return {
        state,
        running,
        needsLogin: state === 'NeedsLogin',
        tailnet: status.CurrentTailnet?.Name ?? '',
        subtitle: running ? (exitNodeLabel ? `via ${exitNodeLabel}` : 'Connected') : SUBTITLES[state] ?? null,
        exitNodeLabel,
        exitNodes: exitNodes(all, exitPeer?.ID ?? null),
        peers: self ? [self, ...others] : others,
        warnings: warnings(status, running, now),
    };
}

export function filterPeers(peers, query) {
    const q = query.trim().toLowerCase();
    if (!q)
        return peers;
    return peers.filter(p => [p.name, p.dnsName, p.ip, p.os].some(f => f.toLowerCase().includes(q)));
}

export function buildAccounts(profiles, current) {
    return (profiles ?? []).map(p => ({id: p.ID, label: accountLabel(p), selected: p.ID === current?.ID}));
}

// Accounts on a custom control server (e.g. Headscale) show the server, so two logins with the same name differ.
export function accountLabel(profile) {
    const name = profile?.UserProfile?.LoginName || profile?.Name || 'New account';
    const host = /^[a-z]+:\/\/([^/:?#]+)/i.exec(profile?.ControlURL ?? '')?.[1]?.toLowerCase();
    return host && !DEFAULT_CONTROL_HOSTS.includes(host) ? `${name} · ${host}` : name;
}

// '' means Tailscale's own server. Anything else must be a plain http(s) URL.
export function normalizeLoginServer(input) {
    const url = input.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(url))
        throw new Error(`"${input.trim()}" is not a login server URL. Use the form https://headscale.example.com`);
    return url;
}

// Taildrop file names come from other devices: keep a plain base name only.
export function safeFileName(name) {
    const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '');
    return base && base !== '.' && base !== '..' ? base : null;
}

// "photo.jpg" -> "photo (2).jpg", so received files never overwrite existing ones.
export function numberedName(name, n) {
    if (n === 0)
        return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

export function flag(countryCode) {
    if (!/^[A-Za-z]{2}$/.test(countryCode ?? ''))
        return '';
    return String.fromCodePoint(...[...countryCode.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

export function ago(iso, now) {
    const t = Date.parse(iso ?? '');
    if (!(t > 0)) // Go's zero time ("0001-01-01…") parses negative
        return '';
    const minutes = Math.max(0, Math.round((now - t) / 60000));
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48)
        return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

// Mullvad (and other location-based) exit nodes carry a Location; they can number in the hundreds,
// so they only appear in the exit node menu, never in the device list.
function isLocationNode(p) {
    return Boolean(p.ExitNodeOption && p.Location?.CountryCode);
}

function toPeer(p, running, now) {
    const dnsName = (p.DNSName ?? '').replace(/\.$/, '');
    const ips = p.TailscaleIPs ?? [];
    return {
        id: p.ID,
        // HostName can be generic ("localhost" on iOS); the MagicDNS label is what users type.
        name: dnsName.split('.')[0] || p.HostName || '',
        dnsName,
        ip: ips.find(ip => !ip.includes(':')) ?? ips[0] ?? '',
        os: p.OS ?? '',
        online: Boolean(p.Online),
        connection: connection(p, running, now),
        taildrop: p.TaildropTarget === TAILDROP_AVAILABLE,
    };
}

function connection(p, running, now) {
    if (!p.Online) {
        const seen = ago(p.LastSeen, now);
        return seen ? `last seen ${seen}` : 'offline';
    }
    if (!running)
        return 'online';
    if (p.CurAddr)
        return 'direct';
    // Tailscale connects lazily; without recent traffic there is no path yet.
    if (!p.Active)
        return 'idle';
    return p.Relay ? `relay (${p.Relay})` : 'relay';
}

function exitLabel(p) {
    if (!isLocationNode(p))
        return toPeer(p, false, 0).name;
    const {CountryCode, City, Country} = p.Location;
    return `${flag(CountryCode)} ${City || Country}`;
}

function exitNodes(all, currentId) {
    const options = all.filter(p => p.ExitNodeOption);
    const tailnet = options
        .filter(p => !isLocationNode(p))
        .map(p => ({id: p.ID, label: exitLabel(p), online: Boolean(p.Online), selected: p.ID === currentId}))
        .sort((a, b) => a.label.localeCompare(b.label));

    // One entry per country, using the node Tailscale ranks highest there (like the official clients).
    const byCountry = new Map();
    for (const p of options.filter(isLocationNode)) {
        const code = p.Location.CountryCode;
        const entry = byCountry.get(code) ?? {best: p, ids: []};
        entry.ids.push(p.ID);
        if ((p.Location.Priority ?? 0) > (entry.best.Location.Priority ?? 0))
            entry.best = p;
        byCountry.set(code, entry);
    }
    const countries = [...byCountry.values()]
        .sort((a, b) => a.best.Location.Country.localeCompare(b.best.Location.Country))
        .map(({best, ids}) => ({
            id: best.ID,
            label: `${flag(best.Location.CountryCode)} ${best.Location.Country}`,
            online: Boolean(best.Online),
            selected: ids.includes(currentId),
        }));

    return {tailnet, countries};
}

function warnings(status, running, now) {
    // Health messages describe a live connection; while stopped they are stale noise.
    const out = running ? (status.Health ?? []).filter(m => m !== STOPPED_HEALTH) : [];
    const expiry = Date.parse(status.Self?.KeyExpiry ?? '');
    if (expiry > 0) {
        const days = Math.ceil((expiry - now) / DAY_MS);
        if (days <= 0)
            out.push('Device key expired. Re-authenticate this device in the Tailscale admin console.');
        else if (days <= KEY_EXPIRY_WARN_DAYS)
            out.push(`Device key expires in ${days} day${days === 1 ? '' : 's'}.`);
    }
    return out;
}

function byOnlineThenName(a, b) {
    return Number(b.online) - Number(a.online) || a.name.localeCompare(b.name);
}

// ---- Serve / Funnel ----------------------------------------------------------------------------
// Each shared service gets its own HTTPS port on this device's MagicDNS name, mounted at "/", so apps
// that assume they live at the root keep working. These are the ports Funnel allows by default.
const SERVE_PORTS = [443, 8443, 10000];
const FUNNEL_PORTS_CAP = 'https://tailscale.com/cap/funnel-ports';

// What this device may share: HTTPS needs the "https" node attribute, Funnel also "funnel" plus
// the ports listed in the funnel-ports attribute.
export function sharingAccess(self) {
    const caps = Object.keys(self?.CapMap ?? {});
    const https = caps.includes('https');
    const portsCap = caps.find(c => c.startsWith(`${FUNNEL_PORTS_CAP}?`));
    const funnelPorts = https && caps.includes('funnel') && portsCap
        ? (new RegExp('[?&]ports=([^&]*)').exec(portsCap)?.[1] ?? '').split(',').map(Number).filter(Boolean)
        : [];
    return {https, funnelPorts};
}

export function listServices(config) {
    const services = [];
    for (const [hostPort, web] of Object.entries(config?.Web ?? {})) {
        const [host, port] = splitHostPort(hostPort);
        const scheme = config.TCP?.[port]?.HTTP ? 'http' : 'https';
        const portSuffix = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : `:${port}`;
        for (const [mount, handler] of Object.entries(web?.Handlers ?? {})) {
            services.push({
                port,
                hostPort,
                url: `${scheme}://${host}${portSuffix}${mount}`,
                target: handler.Proxy || handler.Path || (handler.Text !== undefined ? 'text' : ''),
                funnel: Boolean(config.AllowFunnel?.[hostPort]),
            });
        }
    }
    return services
        .sort((a, b) => a.port - b.port || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
        .map(({port: _port, ...service}) => service);
}

// "3000", "localhost:3000" or a full http(s) URL -> a proxy target tailscaled accepts.
export function normalizeServeTarget(input) {
    const value = input.trim();
    const port = n => Number.isInteger(n) && n > 0 && n < 65536;
    if (/^\d+$/.test(value) && port(Number(value)))
        return `http://127.0.0.1:${value}`;
    const hostPort = /^([\w.-]+|\[[0-9a-f:]+\]):(\d+)$/i.exec(value);
    if (hostPort && port(Number(hostPort[2])))
        return `http://${value}`;
    const url = /^https?:\/\/([\w.-]+|\[[0-9a-f:]+\])(?::(\d+))?(\/[^\s?#]*)?$/i.exec(value);
    if (url && (url[2] === undefined || port(Number(url[2]))))
        return value;
    throw new Error(`"${value}" is not a local port or URL. Use a port like 3000, or http://localhost:3000`);
}

// Returns a new config; never mutates the one passed in (it may be retried after an ETag conflict).
export function addService(config, host, target, {funnel = false, funnelPorts = []} = {}) {
    const next = clone(config);
    const candidates = funnel ? SERVE_PORTS.filter(p => funnelPorts.includes(p)) : SERVE_PORTS;
    const port = candidates.find(p => !next.TCP?.[p]);
    if (port === undefined)
        throw new Error(`No free port to share on: ${candidates.join(', ')} are already in use. Remove a service first.`);
    const hostPort = `${host}:${port}`;
    next.TCP = {...next.TCP, [port]: {HTTPS: true}};
    next.Web = {...next.Web, [hostPort]: {Handlers: {'/': {Proxy: target}}}};
    if (funnel)
        next.AllowFunnel = {...next.AllowFunnel, [hostPort]: true};
    return {config: next, url: listServices({TCP: next.TCP, Web: {[hostPort]: next.Web[hostPort]}})[0].url};
}

export function removeService(config, hostPort) {
    const next = clone(config);
    const [, port] = splitHostPort(hostPort);
    delete next.Web?.[hostPort];
    delete next.AllowFunnel?.[hostPort];
    // The TCP port only exists for web serving if no other host name still uses it.
    if (!Object.keys(next.Web ?? {}).some(hp => splitHostPort(hp)[1] === port))
        delete next.TCP?.[port];
    return prune(next);
}

export function makeTailnetOnly(config, hostPort) {
    const next = clone(config);
    delete next.AllowFunnel?.[hostPort];
    return prune(next);
}

function splitHostPort(hostPort) {
    const i = hostPort.lastIndexOf(':');
    return [hostPort.slice(0, i), Number(hostPort.slice(i + 1))];
}

function clone(config) {
    return JSON.parse(JSON.stringify(config ?? {}));
}

function prune(config) {
    for (const key of ['TCP', 'Web', 'AllowFunnel']) {
        if (config[key] && !Object.keys(config[key]).length)
            delete config[key];
    }
    return config;
}

// Minimal client for tailscaled's LocalAPI over its unix socket (the same API the tailscale CLI uses).
// The LocalAPI is not a documented stable interface; the endpoints used here are the ones the CLI relies on.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'read_async');

const SOCKET = '/var/run/tailscale/tailscaled.sock';
const BASE = 'http://local-tailscaled.sock/localapi/v0';
// ipn.NotifyWatchOpt: InitialState | InitialPrefs | NoPrivateKeys
const WATCH_MASK = 2 | 4 | 16;
const RETRY_SECONDS = 5;

export function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class LocalApi {
    constructor() {
        const remote = Gio.UnixSocketAddress.new(SOCKET);
        this._session = new Soup.Session({remote_connectable: remote});
        // The event stream can stay silent for hours; no I/O timeout on it.
        this._watchSession = new Soup.Session({remote_connectable: remote, timeout: 0});
        this._cancellable = new Gio.Cancellable();
        this._sleepId = 0;
        this.loginPending = false;
    }

    status() {
        return this._request('GET', '/status');
    }

    // LocalAPI's MaskedPrefs only applies fields whose <Name>Set flag is true.
    setPrefs(prefs) {
        const body = {...prefs};
        for (const key of Object.keys(prefs))
            body[`${key}Set`] = true;
        return this._request('PATCH', '/prefs', body);
    }

    setExitNode(id) {
        return this.setPrefs({ExitNodeID: id, ExitNodeIP: ''});
    }

    suggestExitNode() {
        return this._request('GET', '/suggest-exit-node');
    }

    loginInteractive() {
        this.loginPending = true;
        return this._request('POST', '/login-interactive');
    }

    profiles() {
        return this._request('GET', '/profiles/');
    }

    currentProfile() {
        return this._request('GET', '/profiles/current');
    }

    switchProfile(id) {
        return this._request('POST', `/profiles/${encodeURIComponent(id)}`);
    }

    // Same sequence as `tailscale login --login-server=URL`: a new empty profile (existing accounts are kept),
    // pointed at the server, then interactive login. An empty controlURL means Tailscale's own server.
    async addAccount(controlURL) {
        await this._request('PUT', '/profiles/');
        if (controlURL)
            await this.setPrefs({ControlURL: controlURL});
        await this.loginInteractive();
    }

    async waitingFiles() {
        return await this._request('GET', '/files/') ?? [];
    }

    async openWaitingFile(name) {
        const msg = Soup.Message.new('GET', `${BASE}/files/${encodeURIComponent(name)}`);
        const stream = await this._session.send_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        this._check(msg, '');
        return stream;
    }

    deleteWaitingFile(name) {
        return this._request('DELETE', `/files/${encodeURIComponent(name)}`);
    }

    // Streams the file to tailscaled, which forwards it to the peer; resolves once the peer has it.
    async sendFile(nodeId, file) {
        const info = await file.query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable);
        const stream = await file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable);
        const msg = Soup.Message.new('PUT',
            `${BASE}/file-put/${encodeURIComponent(nodeId)}/${encodeURIComponent(file.get_basename())}`);
        msg.set_request_body('application/octet-stream', stream, info.get_size());
        return this._send(msg);
    }

    async serveConfig() {
        const msg = Soup.Message.new('GET', `${BASE}/serve-config`);
        const config = await this._send(msg) ?? {};
        return {config, etag: msg.get_response_headers().get_one('Etag')};
    }

    // Read-modify-write guarded by the ETag, so a concurrent `tailscale serve` is never overwritten.
    // `change` gets the current config and returns {config, ...extra}; extra is passed through.
    async updateServeConfig(change) {
        for (let attempt = 1; ; attempt++) {
            const {config, etag} = await this.serveConfig();
            const result = change(config);
            const msg = Soup.Message.new('POST', `${BASE}/serve-config`);
            msg.get_request_headers().append('If-Match', etag);
            msg.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(result.config))));
            try {
                await this._send(msg);
                return result;
            } catch (e) {
                if (msg.get_status() !== Soup.Status.PRECONDITION_FAILED || attempt === 3)
                    throw e;
            }
        }
    }

    get cancellable() {
        return this._cancellable;
    }

    // Streams ipn.Notify objects until destroy(). Reconnects after errors (daemon restart, socket gone).
    async watch(onNotify, onError) {
        const decoder = new TextDecoder();
        while (!this._cancellable.is_cancelled()) {
            try {
                const msg = Soup.Message.new('GET', `${BASE}/watch-ipn-bus?mask=${WATCH_MASK}`);
                const stream = await this._watchSession.send_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
                if (msg.get_status() !== Soup.Status.OK)
                    throw new Error(`watch-ipn-bus: HTTP ${msg.get_status()}`);
                const lines = new Gio.DataInputStream({base_stream: stream});
                for (;;) {
                    const [line] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable);
                    if (line === null)
                        break; // tailscaled closed the stream
                    if (line.length)
                        onNotify(JSON.parse(decoder.decode(line)));
                }
            } catch (e) {
                if (isCancelled(e))
                    return;
                onError(e);
            }
            await this._sleep(RETRY_SECONDS);
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._sleepId)
            GLib.source_remove(this._sleepId);
        this._sleepId = 0;
        this._session.abort();
        this._watchSession.abort();
    }

    async _request(method, path, body) {
        const msg = Soup.Message.new(method, `${BASE}${path}`);
        if (body !== undefined) {
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)));
            msg.set_request_body_from_bytes('application/json', bytes);
        }
        return this._send(msg);
    }

    async _send(msg) {
        const reply = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        const text = new TextDecoder().decode(reply.get_data() ?? new Uint8Array()).trim();
        this._check(msg, text);
        const [contentType] = msg.get_response_headers().get_content_type();
        return text && contentType === 'application/json' ? JSON.parse(text) : null;
    }

    _check(msg, text) {
        const code = msg.get_status();
        if (code === Soup.Status.FORBIDDEN)
            throw new Error('Permission denied. Make your user the Tailscale operator: sudo tailscale set --operator=$USER');
        if (code < 200 || code >= 300)
            throw new Error(`${msg.get_method()} ${msg.get_uri().get_path()}: HTTP ${code} ${text}`);
    }

    _sleep(seconds) {
        return new Promise(resolve => {
            this._sleepId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                this._sleepId = 0;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}

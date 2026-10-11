// The desktop side of Taildrop: picking files to send, saving files that arrive.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {numberedName, safeFileName} from './model.js';

Gio._promisify(Gio.File.prototype, 'create_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.OutputStream.prototype, 'splice_async');

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';

// GNOME Shell has no GTK, so files are picked through the desktop portal's FileChooser.
export class FilePicker {
    constructor() {
        this._subscriptions = new Set();
    }

    // Resolves to the chosen Gio.Files, or [] if the dialog was cancelled.
    pick(title) {
        const bus = Gio.DBus.session;
        const token = `tailnet_${GLib.uuid_string_random().replaceAll('-', '')}`;
        const sender = bus.get_unique_name().slice(1).replaceAll('.', '_');
        const requestPath = `${PORTAL_PATH}/request/${sender}/${token}`;

        return new Promise((resolve, reject) => {
            // Subscribe before calling, so a fast response can't be missed.
            const id = bus.signal_subscribe(PORTAL, 'org.freedesktop.portal.Request', 'Response', requestPath,
                null, Gio.DBusSignalFlags.NONE, (_conn, _sender, _path, _iface, _signal, params) => {
                    this._unsubscribe(id);
                    const [code, results] = params.recursiveUnpack();
                    resolve(code === 0 ? (results.uris ?? []).map(uri => Gio.File.new_for_uri(uri)) : []);
                });
            this._subscriptions.add(id);

            const options = {
                handle_token: new GLib.Variant('s', token),
                multiple: new GLib.Variant('b', true),
                accept_label: new GLib.Variant('s', 'Send'),
            };
            bus.call(PORTAL, PORTAL_PATH, 'org.freedesktop.portal.FileChooser', 'OpenFile',
                new GLib.Variant('(ssa{sv})', ['', title, options]),
                null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                    try {
                        conn.call_finish(res);
                    } catch (e) {
                        this._unsubscribe(id);
                        reject(e);
                    }
                });
        });
    }

    destroy() {
        [...this._subscriptions].forEach(id => this._unsubscribe(id));
    }

    _unsubscribe(id) {
        if (this._subscriptions.delete(id))
            Gio.DBus.session.signal_unsubscribe(id);
    }
}

export function downloadsDir() {
    return Gio.File.new_for_path(
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? GLib.get_home_dir());
}

// Moves every file tailscaled is holding into `dir`. Never overwrites; a file is only removed from
// tailscaled after it is fully written, so a failed save can be retried.
export async function receiveWaitingFiles(api, dir) {
    const saved = [];
    for (const {Name} of await api.waitingFiles()) {
        const name = safeFileName(Name);
        if (!name)
            continue; // tailscaled already rejects such names; never write outside `dir` regardless
        const input = await api.openWaitingFile(Name);
        const [file, output] = await createUnique(dir, name, api.cancellable);
        try {
            await output.splice_async(input,
                Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
                GLib.PRIORITY_DEFAULT, api.cancellable);
        } catch (e) {
            await file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
            throw e;
        }
        await api.deleteWaitingFile(Name);
        saved.push(file);
    }
    return saved;
}

async function createUnique(dir, name, cancellable) {
    for (let n = 0; ; n++) {
        const file = dir.get_child(numberedName(name, n));
        try {
            return [file, await file.create_async(Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable)];
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)))
                throw e;
        }
    }
}

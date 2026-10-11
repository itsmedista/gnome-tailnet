import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {LocalApi, isCancelled} from './localapi.js';
import {
    accountLabel, addService, buildAccounts, buildModel, filterPeers, listServices, makeTailnetOnly,
    normalizeLoginServer, normalizeServeTarget, removeService, sharingAccess,
} from './model.js';
import {FilePicker, downloadsDir, receiveWaitingFiles} from './taildrop.js';

const ICON = 'network-vpn-symbolic';
const WARNING_ICON = 'dialog-warning-symbolic';
const REFRESH_DEBOUNCE_MS = 250;

// A two-line menu row: title, a detail line, optional icon buttons. Clicking the row copies `copy.text`.
const RowItem = GObject.registerClass(
class RowItem extends PopupMenu.PopupBaseMenuItem {
    constructor(title, detail, copy) {
        super();
        this._text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._text.add_child(new St.Label({text: title}));
        this._detail = new St.Label({text: detail, style_class: 'tailnet-detail'});
        this._text.add_child(this._detail);
        this.add_child(this._text);
        this.connect('activate', () => this.copy(copy.text, copy.what));
    }

    addButton(iconName, accessibleName, onClicked) {
        const button = new St.Button({
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
            style_class: 'icon-button tailnet-button',
            accessible_name: accessibleName,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClicked);
        this.add_child(button);
    }

    // The "copied" note stays until the next refresh rebuilds the row, so no timer is needed.
    copy(text, what) {
        if (!text)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._detail.text = `${what} copied: ${text}`;
    }
});

const PeerItem = GObject.registerClass(
class PeerItem extends RowItem {
    // onSend is set only for devices that can receive Taildrop files right now.
    constructor(peer, onSend) {
        super(peer.name, [peer.connection, peer.ip].filter(Boolean).join(' · '), {text: peer.ip, what: 'IP'});
        this.insert_child_below(new St.Label({
            text: '●',
            style_class: peer.online ? 'tailnet-dot tailnet-dot-online' : 'tailnet-dot',
            y_align: Clutter.ActorAlign.CENTER,
        }), this._text);
        if (onSend)
            this.addButton('document-send-symbolic', `Send files to ${peer.name}`, onSend);
        if (peer.dnsName)
            this.addButton('edit-copy-symbolic', `Copy ${peer.dnsName}`, () => this.copy(peer.dnsName, 'Name'));
    }
});

const ServiceItem = GObject.registerClass(
class ServiceItem extends RowItem {
    constructor(service, {onRemove, onMakePrivate}) {
        const reach = service.funnel ? 'public on the internet' : 'tailnet only';
        super(service.url, `→ ${service.target} · ${reach}`, {text: service.url, what: 'URL'});
        // Going public only happens from the explicit "Share publicly" action, never from a row button.
        if (service.funnel)
            this.addButton('changes-prevent-symbolic', `Make ${service.url} tailnet only`, onMakePrivate);
        this.addButton('user-trash-symbolic', `Stop sharing ${service.url}`, onRemove);
    }
});

const TailnetToggle = GObject.registerClass(
class TailnetToggle extends QuickMenuToggle {
    constructor(api, {sendFiles, refresh}) {
        super({title: 'Tailscale', iconName: ICON, toggleMode: false});
        this._api = api;
        this._sendFiles = sendFiles;
        this._refresh = refresh;
        this._model = null;
        this._sharing = null;

        this.menu.setHeader(ICON, 'Tailscale');

        this._warnings = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._warnings);

        this._loginItem = new PopupMenu.PopupMenuItem('Log in…');
        this._loginItem.connect('activate', () => this._run(() => this._api.loginInteractive()));
        this.menu.addMenuItem(this._loginItem);

        this._buildAccountMenu();

        this._exitMenu = new PopupMenu.PopupSubMenuMenuItem('Exit node: None');
        this.menu.addMenuItem(this._exitMenu);
        this._buildSharingMenu();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._search = new St.Entry({hint_text: 'Search devices', can_focus: true, x_expand: true});
        this._search.clutter_text.connect('text-changed', () => this._renderPeers());
        const searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        searchItem.add_child(this._search);
        this.menu.addMenuItem(searchItem);

        // Quick Settings menus don't scroll, so long tailnets would run off screen without this.
        this._peers = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({
            style_class: 'tailnet-peers',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        scroll.set_child(this._peers.actor);
        const scrollSection = new PopupMenu.PopupMenuSection();
        scrollSection.actor.add_child(scroll);
        this.menu.addMenuItem(scrollSection);

        this.connect('clicked', () => this._run(() => this._model?.needsLogin
            ? this._api.loginInteractive()
            : this._api.setPrefs({WantRunning: !this.checked})));
    }

    // The account list and the server entry are built once; only the list is re-rendered,
    // so a refresh never wipes a half-typed server URL.
    _buildAccountMenu() {
        this._accountMenu = new PopupMenu.PopupSubMenuMenuItem('Account');
        this.menu.addMenuItem(this._accountMenu);
        const menu = this._accountMenu.menu;

        this._accounts = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._accounts);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Add account'));

        this._serverEntry = new St.Entry({hint_text: 'Login server (empty = Tailscale)', can_focus: true, x_expand: true});
        const entryItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        entryItem.add_child(this._serverEntry);
        menu.addMenuItem(entryItem);

        const addAccount = () => this._run(async () => {
            const server = normalizeLoginServer(this._serverEntry.text);
            await this._api.addAccount(server);
            this._serverEntry.text = '';
        });
        this._serverEntry.clutter_text.connect('activate', addAccount);
        const addItem = new PopupMenu.PopupMenuItem('Log in to new account…');
        addItem.connect('activate', addAccount);
        menu.addMenuItem(addItem);
    }

    // Like the account menu, the form is built once so refreshes keep what the user typed.
    _buildSharingMenu() {
        this._sharingMenu = new PopupMenu.PopupSubMenuMenuItem('Sharing');
        this.menu.addMenuItem(this._sharingMenu);
        const menu = this._sharingMenu.menu;

        this._services = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._services);

        this._httpsOffItem = new PopupMenu.PopupMenuItem(
            'HTTPS is off for this tailnet. Turn it on in the admin console to share services.', {reactive: false});
        this._httpsOffItem.label.clutter_text.line_wrap = true;
        this._httpsOffItem.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        menu.addMenuItem(this._httpsOffItem);

        this._shareForm = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._shareForm);
        this._shareForm.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Share a local service'));
        this._targetEntry = new St.Entry({hint_text: 'Local port or URL, e.g. 3000', can_focus: true, x_expand: true});
        // Enter takes the safe choice: tailnet only.
        this._targetEntry.clutter_text.connect('activate', () => this._share(false));
        const entryItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        entryItem.add_child(this._targetEntry);
        this._shareForm.addMenuItem(entryItem);

        const tailnetItem = new PopupMenu.PopupMenuItem('Share in tailnet');
        tailnetItem.connect('activate', () => this._share(false));
        this._shareForm.addMenuItem(tailnetItem);
        this._sharePublicItem = new PopupMenu.PopupMenuItem('Share publicly on the internet (Funnel)');
        this._sharePublicItem.connect('activate', () => this._share(true));
        this._shareForm.addMenuItem(this._sharePublicItem);
    }

    _share(funnel) {
        this._run(async () => {
            const target = normalizeServeTarget(this._targetEntry.text);
            const {access, host} = this._sharing;
            const {url} = await this._api.updateServeConfig(
                config => addService(config, host, target, {funnel, funnelPorts: access.funnelPorts}));
            this._targetEntry.text = '';
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, url);
            Main.notify('Tailscale', `${funnel ? 'Public on the internet' : 'Shared in your tailnet'}: ${url} (copied)`);
            this._refresh();
        });
    }

    _changeSharing(change, message) {
        this._run(async () => {
            await this._api.updateServeConfig(config => ({config: change(config)}));
            Main.notify('Tailscale', message);
            this._refresh();
        });
    }

    _renderSharing() {
        const {access, services, host} = this._sharing;
        this._sharingMenu.label.text = services.length
            ? `Sharing: ${services.length} service${services.length === 1 ? '' : 's'}`
            : 'Sharing: off';
        this._services.removeAll();
        for (const service of services) {
            this._services.addMenuItem(new ServiceItem(service, {
                onRemove: () => this._changeSharing(c => removeService(c, service.hostPort), `Stopped sharing ${service.url}`),
                onMakePrivate: () => this._changeSharing(c => makeTailnetOnly(c, service.hostPort), `${service.url} is now tailnet only`),
            }));
        }
        this._httpsOffItem.visible = !access.https;
        this._shareForm.actor.visible = access.https && Boolean(host);
        this._sharePublicItem.visible = access.funnelPorts.length > 0;
    }

    update(model, accounts, currentAccount, sharing) {
        this._model = model;
        this.checked = model.running;
        this.subtitle = model.subtitle;
        this.iconName = model.running && model.warnings.length ? WARNING_ICON : ICON;
        this.menu.setHeader(ICON, 'Tailscale', model.tailnet);
        this._loginItem.visible = model.needsLogin;
        this._accountMenu.visible = true;
        this._exitMenu.visible = true;
        this._sharingMenu.visible = Boolean(sharing);
        this._renderWarnings(model.warnings);
        this._renderAccounts(accounts, currentAccount);
        this._sharing = sharing;
        if (sharing)
            this._renderSharing();
        this._renderExitNodes();
        this._renderPeers();
    }

    _renderAccounts(accounts, currentAccount) {
        this._accountMenu.label.text = `Account: ${currentAccount}`;
        this._accounts.removeAll();
        for (const account of accounts) {
            const item = new PopupMenu.PopupMenuItem(account.label);
            item.setOrnament(account.selected ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            if (!account.selected)
                item.connect('activate', () => this._run(() => this._api.switchProfile(account.id)));
            this._accounts.addMenuItem(item);
        }
    }

    setUnavailable(reason) {
        this._model = null;
        this.checked = false;
        this.subtitle = 'Unavailable';
        this.iconName = ICON;
        this.menu.setHeader(ICON, 'Tailscale', 'tailscaled is not reachable');
        this._loginItem.visible = false;
        this._accountMenu.visible = false;
        this._exitMenu.visible = false;
        this._sharingMenu.visible = false;
        this._renderWarnings([reason]);
        this._renderPeers();
    }

    _renderWarnings(messages) {
        this._warnings.removeAll();
        for (const message of messages) {
            const item = new PopupMenu.PopupImageMenuItem(message, WARNING_ICON, {reactive: false});
            item.label.clutter_text.line_wrap = true;
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._warnings.addMenuItem(item);
        }
    }

    _renderExitNodes() {
        const {exitNodes: {tailnet, countries}, exitNodeLabel} = this._model;
        const menu = this._exitMenu.menu;
        menu.removeAll();
        this._exitMenu.label.text = `Exit node: ${exitNodeLabel ?? 'None'}`;

        this._addExitItem(menu, {id: '', label: 'None', online: true, selected: !exitNodeLabel});
        if (!tailnet.length && !countries.length) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem('No exit nodes in this tailnet', {reactive: false}));
            return;
        }

        const suggested = new PopupMenu.PopupMenuItem('Suggested (best available)');
        suggested.connect('activate', () => this._run(async () => {
            const {ID} = await this._api.suggestExitNode();
            if (!ID)
                throw new Error('Tailscale has no exit node to suggest right now.');
            await this._api.setExitNode(ID);
        }));
        menu.addMenuItem(suggested);

        if (tailnet.length)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Tailnet'));
        tailnet.forEach(entry => this._addExitItem(menu, entry));
        if (countries.length)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Mullvad'));
        countries.forEach(entry => this._addExitItem(menu, entry));
    }

    _addExitItem(menu, entry) {
        const item = new PopupMenu.PopupMenuItem(entry.label);
        item.setOrnament(entry.selected ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        item.sensitive = entry.online;
        item.connect('activate', () => this._run(() => this._api.setExitNode(entry.id)));
        menu.addMenuItem(item);
    }

    _renderPeers() {
        this._peers.removeAll();
        if (!this._model)
            return;
        const query = this._search.text;
        const peers = filterPeers(this._model.peers, query);
        for (const peer of peers) {
            const onSend = this._model.running && peer.taildrop ? () => this._sendFiles(peer) : null;
            this._peers.addMenuItem(new PeerItem(peer, onSend));
        }
        if (!peers.length)
            this._peers.addMenuItem(new PopupMenu.PopupMenuItem(query ? 'No matching devices' : 'No devices', {reactive: false}));
    }

    _run(action) {
        Promise.resolve().then(action).catch(e => {
            if (!isCancelled(e))
                Main.notifyError('Tailscale', e.message);
        });
    }
});

const TailnetIndicator = GObject.registerClass(
class TailnetIndicator extends SystemIndicator {
    constructor() {
        super();
        this._icon = this._addIndicator();
        this._icon.icon_name = ICON;
        this._icon.visible = false;
        this._refreshId = 0;
        this._watchFailing = false;
        this._receiving = false;
        this._receiveAgain = false;
        this._checkedWaitingFiles = false;

        this._api = new LocalApi();
        this._picker = new FilePicker();
        this._toggle = new TailnetToggle(this._api, {
            sendFiles: peer => this._sendFiles(peer),
            refresh: () => this._queueRefresh(),
        });
        // Peer paths (direct/relay) change without bus events, so re-read whenever the menu opens.
        this._toggle.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._queueRefresh();
        });
        this.quickSettingsItems.push(this._toggle);

        this._api.watch(notify => this._onNotify(notify), error => this._onWatchError(error)).catch(logError);
        this._refresh();
    }

    // Every bus event triggers one debounced /status read instead of applying Notify deltas: simpler and
    // always consistent, at the cost of a full status read per event on very large tailnets.
    _onNotify(notify) {
        this._watchFailing = false;
        if (notify.BrowseToURL && this._api.loginPending) {
            this._api.loginPending = false;
            Gio.AppInfo.launch_default_for_uri(notify.BrowseToURL, null);
        }
        if (notify.ErrMessage)
            Main.notifyError('Tailscale', notify.ErrMessage);
        if ('FilesWaiting' in notify)
            this._receiveFiles();
        this._queueRefresh();
    }

    _sendFiles(peer) {
        Main.panel.closeQuickSettings();
        this._report('Taildrop', async () => {
            const files = await this._picker.pick(`Send to ${peer.name} with Taildrop`);
            if (!files.length)
                return;
            const what = files.length === 1 ? files[0].get_basename() : `${files.length} files`;
            Main.notify('Taildrop', `Sending ${what} to ${peer.name}…`);
            for (const file of files)
                await this._api.sendFile(peer.id, file);
            Main.notify('Taildrop', `Sent ${what} to ${peer.name}`);
        });
    }

    // Auto-saves to Downloads, like Tailscale's macOS and Windows clients. Events that arrive
    // mid-transfer set _receiveAgain, so files sent during a save are picked up right after it.
    _receiveFiles() {
        if (this._receiving) {
            this._receiveAgain = true;
            return;
        }
        this._receiving = true;
        this._report('Taildrop', async () => {
            try {
                do {
                    this._receiveAgain = false;
                    const saved = await receiveWaitingFiles(this._api, downloadsDir());
                    if (saved.length)
                        this._notifyReceived(saved);
                } while (this._receiveAgain);
            } finally {
                this._receiving = false;
            }
        });
    }

    _notifyReceived(files) {
        const folder = files[0].get_parent();
        const what = files.length === 1 ? files[0].get_basename() : `${files.length} files`;
        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source,
            title: 'Taildrop',
            body: `Received ${what} in ${folder.get_basename()}`,
        });
        notification.addAction('Open folder', () => Gio.AppInfo.launch_default_for_uri(folder.get_uri(), null));
        source.addNotification(notification);
    }

    _report(title, action) {
        action().catch(e => {
            if (!isCancelled(e))
                Main.notifyError(title, e.message);
        });
    }

    _onWatchError(error) {
        // Retries every few seconds while tailscaled is down; log the outage once, not every retry.
        if (!this._watchFailing)
            console.warn(`Tailnet: lost tailscaled event stream, retrying: ${error.message}`);
        this._watchFailing = true;
        this._queueRefresh();
    }

    _queueRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DEBOUNCE_MS, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        try {
            const [status, profiles, current] = await Promise.all([
                this._api.status(), this._api.profiles(), this._api.currentProfile()]);
            const model = buildModel(status);
            // Sharing only means something while connected; serve state is read only then.
            const sharing = model.running ? {
                access: sharingAccess(status.Self),
                services: listServices((await this._api.serveConfig()).config),
                host: (status.Self?.DNSName ?? '').replace(/\.$/, ''),
            } : null;
            this._toggle.update(model, buildAccounts(profiles, current), accountLabel(current), sharing);
            this._icon.visible = model.running;
            // Files that arrived while the shell wasn't watching (e.g. before login) have no event.
            if (model.running && !this._checkedWaitingFiles) {
                this._checkedWaitingFiles = true;
                this._receiveFiles();
            }
        } catch (e) {
            if (isCancelled(e))
                return;
            this._toggle.setUnavailable(e.message);
            this._icon.visible = false;
        }
    }

    destroy() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        this._picker.destroy();
        this._api.destroy();
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class TailnetExtension extends Extension {
    enable() {
        this._indicator = new TailnetIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}

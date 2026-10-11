# Tailnet

Tailscale in GNOME Shell's Quick Settings. Updates live from `tailscaled`'s event stream instead of polling.

Unofficial. Not affiliated with Tailscale Inc.

## Features

- Connect and disconnect, log in, health and key-expiry warnings
- Searchable device list showing direct, relay or idle connections; click to copy an IP, button to copy the MagicDNS name
- Exit nodes: none, suggested, your tailnet's nodes, Mullvad by country
- Accounts: switch between them, add one, or log in to a custom server such as Headscale
- Taildrop: send files from the device list, receive files into `~/Downloads` automatically
- Sharing: serve a local port to your tailnet, or publicly with Funnel

## Requirements

- GNOME Shell 51 (the only version tested)
- Tailscale with `tailscaled` running
- Your user set as the Tailscale operator, so the extension can change settings without root:

  ```
  sudo tailscale set --operator=$USER
  ```

## Install

```
git clone https://github.com/itsmedista/gnome-tailnet.git
ln -s "$PWD/gnome-tailnet" ~/.local/share/gnome-shell/extensions/tailnet@itsmedista.github.io
```

Log out and back in, then enable the extension:

```
gnome-extensions enable tailnet@itsmedista.github.io
```

GNOME Shell only loads extension code at login, so log out and back in again after pulling changes.

## How it works

The extension talks to `tailscaled`'s LocalAPI over `/var/run/tailscale/tailscaled.sock`, the same API the `tailscale` CLI uses. The LocalAPI isn't a documented stable interface, so a future Tailscale release could break the extension.

| File | Role |
|---|---|
| `extension.js` | Quick Settings toggle, menu, panel indicator |
| `localapi.js` | LocalAPI client: requests, event stream, Taildrop transfers, serve config |
| `model.js` | Pure functions turning LocalAPI JSON into what the menu shows; no GNOME imports |
| `taildrop.js` | File picker (desktop portal) and saving received files |

Sharing gives each service its own HTTPS port on this device's MagicDNS name: 443, then 8443, then 10000. Those are the ports Funnel allows by default, so at most three services can be shared at once.

## Tests

```
gjs -m test/model.test.js      # menu logic, no daemon needed
gjs -m test/taildrop.test.js   # saving received files, uses a fake daemon and a temp folder
gjs -m test/localapi.test.js   # read-only checks against the running tailscaled
```

`test/serve.live.test.js` **changes live state**: it shares a dummy tailnet-only service for about a second, removes it, and checks the serve config was restored. Run it only when you mean to.

## License

MIT. See [LICENSE](LICENSE).

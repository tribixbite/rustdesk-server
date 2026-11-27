# RustDesk Server Program

[![build](https://github.com/rustdesk/rustdesk-server/actions/workflows/build.yaml/badge.svg)](https://github.com/rustdesk/rustdesk-server/actions/workflows/build.yaml)

[**Download**](https://github.com/rustdesk/rustdesk-server/releases)

[**Manual**](https://rustdesk.com/docs/en/self-host/)

[**Configuration & environment variables**](docs/environment-variables.md)

[**FAQ**](https://github.com/rustdesk/rustdesk/wiki/FAQ)

[**How to migrate OSS to Pro**](https://rustdesk.com/docs/en/self-host/rustdesk-server-pro/installscript/#convert-from-open-source)

Self-host your own RustDesk server, it is free and open source.

> [!IMPORTANT]
> **Need more features?** [RustDesk Server Pro](https://rustdesk.com/pricing.html) might suit you better.
>
> **Want to develop your own server?** Start with [rustdesk-server-demo](https://github.com/rustdesk/rustdesk-server-demo), a simpler starting point than this repository.

## This fork: Railway deployment, accounts and device list

This fork runs hbbs, hbbr and an account/address-book API on Railway
([docs/railway.md](docs/railway.md), [docs/api.md](docs/api.md)). The values
below are placeholders: the web console's **Overview** page
(`https://<api domain>/`, sign in as an admin) shows the real ones, plus a copy
button for the configuration string and a QR code.

### Desktop client (Windows, macOS, Linux; RustDesk 1.5.0 or later)

1. **Point it at the server.** Settings → **Network**. On an installed Windows
   client, click **Unlock network settings** first (it asks for admin rights).
   - Quickest: in the console's Overview page, click the copy button next to
     the configuration string. Then in RustDesk click **ID/Relay server**, then
     the **paste icon** (*Import server config*) in the dialog's title bar, and
     **OK**. This fills in all four fields.
   - Or type them in: ID server `<hbbs domain>`, Relay server `<hbbr domain>`,
     API server `https://<api domain>` (must start with `https`), Key = the
     server's public key.
2. **Turn on Use WebSocket** (Settings → Network). Railway has no UDP and no
   fixed TCP ports, so the client must reach the server over `wss://`. The
   main window should then show the device as ready.
3. **Turn on direct connections:** Settings → General → Other → **Enable WebRTC
   P2P connection**. It defaults to off for self-hosted servers. With it on,
   sessions try a direct connection first and fall back to the relay. See
   docs/railway.md for when a direct path is possible.
4. **Log in to add the device to your device list.** Click **Login** in the
   account area of the main window (or Settings → Account), and use an account
   created in the console under **Users**. If two-factor authentication is on,
   RustDesk asks for the code next. Once logged in:
   - the device appears in the console under **Devices**, owned by your account,
     with its online status and system info;
   - **Address book** lists your personal book and any shared books, and an
     address you add from any of your devices is synced to the others;
   - **Accessible devices** lists the devices of your account (and of groups
     you were given access to).
5. **Optional, for unattended machines:** set a permanent password under
   Settings → Security, or assign the device from the command line without the
   UI. Use an API token from the console (Sessions & API tokens):
   `rustdesk --assign --token <token> --user_name <user>` (Windows: run from
   the install folder as admin).

Phones: Settings → **ID/Relay server**, then the scan icon reads the console's QR
code; turn on **Use WebSocket** and **Enable WebRTC P2P connection** on the
same page, and log in from **Settings → Login**.

Two Android phones on the same network only connect directly with a fixed
client. The fix is pending upstream; [client-patch/](client-patch/README.md)
builds a fixed copy of 1.5.3.

## How to build manually

```bash
cargo build --release
```

Three executables will be generated in target/release.

- hbbs - RustDesk ID/Rendezvous server
- hbbr - RustDesk relay server
- rustdesk-utils - RustDesk CLI utilities

You can find updated binaries on the [Releases](https://github.com/rustdesk/rustdesk-server/releases) page.

## Configuration

`hbbs` and `hbbr` can be configured with command-line flags, environment
variables, or an `.env` / config file. Run `hbbs --help` or `hbbr --help` to see
the available flags.

The most common options:

| Option | Flag | Env var | Applies to | Purpose |
| --- | --- | --- | --- | --- |
| Key | `-k` | `KEY` | hbbs, hbbr | `hbbs` loads/generates one by default |
| Bind address | `-b` | `BIND` | hbbs, hbbr | Local IP address to listen on (default: all interfaces; requires 1.1.17+) |
| Port | `-p` | `PORT` | hbbs, hbbr | Listening port (hbbs `21116`, hbbr `21117`) |
| Relay servers | `-r` | `RELAY-SERVERS` | hbbs | Override when the relay uses a different address or a non-standard port |
| Force relay | — | `ALWAYS_USE_RELAY` | hbbs | `Y` disables direct connections |
| Log level | — | `RUST_LOG` | hbbs, hbbr | e.g. `debug` (default `info`) |

See **[docs/environment-variables.md](docs/environment-variables.md)** for the
full list of variables, the file/flag/env precedence rules, database and relay
bandwidth tuning, Docker image variables, and examples.

## Installation

Please follow this [doc](https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/)

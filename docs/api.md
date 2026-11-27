# RustDesk API and web console (`api/`)

The open-source RustDesk server has no "API server". The official client still
calls one for account login, address books, device management, strategies and
audit logs; upstream offers it only in RustDesk Server Pro. `api/` implements
that HTTP contract as a separate service, so it never touches upstream files:

- **Stack:** Bun + TypeScript + Hono, SQLite (`bun:sqlite`).
- **OpenAPI:** a 3.1 document at `/openapi.json` and interactive docs at `/docs`.
- **Web console:** a Preact single-page app at `/`.

The contract was taken from the 1.5.3 client source: every endpoint it calls,
with each quirk it depends on. Tests in `api/test/` assert those quirks.

## Features

| Feature | Client side | Console |
|---|---|---|
| Account login | Settings → Login: password, then a TOTP code when 2FA is on; OIDC buttons for configured providers | Users: create, disable, reset password/2FA, admin flag |
| Two-factor login | TOTP code dialog | My account: enrol with QR code, disable |
| Personal address book | "My address book", synced across the user's devices | — |
| Shared address books | Shown in the book selector, with the caller's rule: read, read/write, full control; optional default shared password | Address books: create, share per user, rename, view peers |
| Accessible devices | Group tab: users, devices and device groups the user may see | Device groups: grant users access |
| Devices | Heartbeat and sysinfo (hostname, OS, CPU, memory, version, online status) | Devices: owner, group, strategy, note, name; disconnect a live session; ask for fresh sysinfo; forget the bound machine id |
| Strategies | Client settings pushed through the heartbeat (precedence: device, then owner, then device group) | Strategies: editor for the known options plus custom keys |
| Audit | Connection open/login/close (who, from where, how authenticated), file transfers, security alarms; controller's end-of-session note | Audit: three paged logs |
| `rustdesk --assign` | Assigns user, strategy, address book entry, device group, note, name | Sessions & API tokens: create the API token it needs |
| Client config export | Import server config / QR scan | Overview: string, QR code, copy buttons |

Not provided, with the reason:

- **Email verification codes and email alarms:** there is no mail delivery.
  TOTP covers the second factor.
- **LDAP:** not implemented.
- **GitHub login:** GitHub is OAuth 2.0 without OpenID Connect discovery. Any
  OIDC provider works (Google, Microsoft Entra, GitLab, Okta, Auth0,
  Authentik, Keycloak, …).
- **Device deployment and access control enforced at connect time:** these
  need hbbs to consult the API, which this fork's hbbs does not.
  `/api/devices/deploy` answers `NOT_ENABLED`.
- **Session recording upload (`/api/record`):** the 1.5.3 client never enables it.
- **Switch-sides grants:** stored with a timestamp check. The device signature is
  not verified, because device public keys live in hbbs. hbbs does not consult
  grants either.
- **Raw-TCP API proxy (`HttpProxyRequest` over hbbs):** clients use it only
  when WebSocket mode is off, and this deployment is WebSocket-only.
- **Custom client generator, multiple relay management, web client:** not implemented.

## Variables

| Variable | Default | Meaning |
|---|---|---|
| `API_PORT` | `21114` | listening port (the Railway domain targets it) |
| `DATABASE_PATH` | `/data/rustdesk-api.sqlite3` in the image | SQLite file; mount a volume at `/data` |
| `PUBLIC_URL` | `http://localhost:<port>` | public base URL: OIDC redirect, config export |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / — | first administrator, created only while the user table is empty; startup fails without a password then |
| `TOKEN_TTL_SECONDS` | 30 days | lifetime of login tokens (API tokens do not expire) |
| `RENDEZVOUS_SERVER`, `RELAY_SERVER`, `KEY_PUB` | — | shown in the console and in the config export |
| `OIDC_PROVIDERS` | — | JSON array of `{"name","issuer","clientId","clientSecret","scopes"?}`; redirect URI `<PUBLIC_URL>/api/oidc/callback` |
| `OIDC_AUTO_CREATE` | `N` | `Y` creates a non-admin account on first OIDC login; otherwise the verified email must match an existing user |
| `WEB_DIR` | `/app/dist/web` | built console |

### Google sign-in (set up and verified 2026-11-27)

1. Google Cloud console → new project → Google Auth Platform → Get started:
   app name, support email, audience **External**, contact email.
2. Clients → Create client → **Web application**, authorized redirect URI
   `<PUBLIC_URL>/api/oidc/callback`. Copy the client ID and secret (the secret
   is shown only once).
3. Audience → Test users → add every family member's Google address. While the
   app stays in "Testing" only those accounts can sign in (cap 100), and Google
   shows no verification warning to them. "Publish app" lets any Google
   account reach the login page, which is not needed here.
4. Set `OIDC_PROVIDERS='[{"name":"google","issuer":"https://accounts.google.com","clientId":"…","clientSecret":"…"}]'`
   on the api service, and give each user their Google address in the console
   (Users → edit → email), since `OIDC_AUTO_CREATE` is off.

Verified on the production server: the client's flow (`/api/oidc/auth`, the
Google login in a browser, `/api/oidc/auth-query`) returned a token for the
matching user. The token is handed out once; polling again reports the login
as expired, and reloading the callback page cannot undo a finished login.

Console settings (stored in the database): maximum peers per address book, and
audit retention in days (default 180). Expired sessions, login attempts and
audit records past retention are pruned hourly.

## Security notes

- Passwords are argon2id. Tokens are random 256-bit values, and only their
  SHA-256 is stored.
- Failed logins are throttled: 10 per account and 30 per IP within 15 minutes.
- Heartbeat, sysinfo and audit requests carry no token, only the device's id
  and machine uuid. The first uuid seen for an id is bound to it, and later
  requests with another uuid are ignored or refused. After reinstalling a
  machine, clear the binding in the console (Devices → edit → forget machine id).
- Shared address-book passwords are stored and delivered in plain text to
  everyone who can read the book. That is how the client uses them.

## Development

```sh
cd api
bun install
bunx tsc --noEmit
bun test
bun run build:web
ADMIN_PASSWORD=change-me-now DATABASE_PATH=./data/dev.sqlite3 bun src/index.ts
```

On Termux inside a Claude Code session, run `env -u BUN_BINARY_PATH bun …`.
The `BUN_BINARY_PATH` that leaks into the session's environment makes plain
`bun` run Claude Code itself.

## Deployment

The `api` Railway service builds `api/Dockerfile` from the repository root
(`RAILWAY_DOCKERFILE_PATH=api/Dockerfile`), with a volume at `/data` and its
domain targeting port 21114. `.github/workflows/railway.yml` runs `tsc` and
`bun test`, then deploys it on pushes to master that change `api/`.

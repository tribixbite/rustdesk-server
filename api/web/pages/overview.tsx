/** Counts, server details, the client config string with its QR code, and setup steps. */
import { Api } from "../api";
import { CopyButton, CopyRow, LoadView, PageHead, QrCode, useLoad } from "../ui";

export function Overview() {
  const ov = useLoad(Api.overview);
  return (
    <>
      <PageHead title="Overview" subtitle="Server status and what to enter on each RustDesk client." />
      <LoadView value={ov}>
        {(o) => (
          <>
            <section class="stats" aria-label="Counts">
              <Stat label="Devices" value={o.devices} href="#/devices" />
              <Stat label="Online now" value={o.online} tone="ok" href="#/devices" />
              <Stat label="Users" value={o.users} href="#/users" />
              <Stat label="Shared books" value={o.shared_books} href="#/address-books" />
              <Stat label="Connections (24 h)" value={o.connections_24h} href="#/audit" />
              <Stat label="Alarms (24 h)" value={o.alarms_24h} tone={o.alarms_24h > 0 ? "danger" : undefined} href="#/audit/alarm" />
            </section>

            <div class="grid-2">
              <section class="card">
                <h2>Server details</h2>
                <CopyRow label="ID server" value={o.server.id_server} />
                <CopyRow label="Relay server" value={o.server.relay_server} />
                <CopyRow label="API server" value={o.server.api_server} />
                <CopyRow label="Key" value={o.server.key} />
                {o.server.oidc_providers.length > 0 && (
                  <p class="muted small">Single sign-on: {o.server.oidc_providers.join(", ")}</p>
                )}
              </section>

              <section class="card">
                <h2>Client configuration</h2>
                <p class="muted small">
                  On a phone, open RustDesk → Settings → ID/Relay server and tap the scan icon. On a desktop, copy the string and use “Import server config”
                  on the same screen.
                </p>
                <div class="config-block">
                  <QrCode text={`config=${o.server.config_string}`} label="QR code of the client configuration" />
                  <div class="config-string">
                    <code class="break">{o.server.config_string}</code>
                    <CopyButton text={o.server.config_string} label="Copy config" />
                  </div>
                </div>
              </section>
            </div>

            <section class="card">
              <h2>Setting up a device</h2>
              <ol class="steps">
                <li>
                  In RustDesk open <strong>Settings → Network → ID/Relay server</strong> (on Android: Settings → ID/Relay server).
                </li>
                <li>
                  Enter the <strong>ID server</strong>, <strong>Relay server</strong>, <strong>API server</strong> and <strong>Key</strong> shown above, or
                  import the configuration string / scan the QR code.
                </li>
                <li>
                  Turn on <strong>Use WebSocket</strong> (Settings → Network).
                </li>
                <li>
                  For direct connections between peers, also turn on <strong>Enable WebRTC P2P connection</strong>.
                </li>
                <li>Sign in with a console user account on the device so it shows up under that owner.</li>
              </ol>
            </section>
          </>
        )}
      </LoadView>
    </>
  );
}

function Stat({ label, value, tone, href }: { label: string; value: number; tone?: "ok" | "danger"; href: string }) {
  return (
    <a class={`stat${tone ? ` stat-${tone}` : ""}`} href={href}>
      <span class="stat-value">{value}</span>
      <span class="stat-label">{label}</span>
    </a>
  );
}

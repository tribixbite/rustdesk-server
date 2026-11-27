/** My account: password, two-factor login, my sessions, sign out. */
import { useState } from "preact/hooks";
import { Api, setToken, type AdminUser } from "../api";
import { Badge, CopyButton, dateTime, Empty, FormModal, LoadView, PageHead, QrCode, relativeTime, TextField, toast, useAction, useLoad } from "../ui";
import { KIND_LABEL, sessionDevice } from "./tokens";

const MIN_PASSWORD = 8;

export function Account({ me, onChanged, onSignOut }: { me: AdminUser; onChanged: () => void; onSignOut: () => void }) {
  const sessions = useLoad(Api.mySessions);
  const [dialog, setDialog] = useState<"password" | "totp-on" | "totp-off" | null>(null);
  const [busy, run] = useAction();
  const close = () => setDialog(null);

  return (
    <>
      <PageHead title="My account" subtitle={me.display_name ? `${me.name} · ${me.display_name}` : me.name} />
      <div class="grid-2">
        <section class="card">
          <h2>Profile</h2>
          <dl class="facts">
            <dt>Username</dt>
            <dd>{me.name}</dd>
            <dt>Email</dt>
            <dd>{me.email || "—"}</dd>
            <dt>Role</dt>
            <dd>{me.is_admin ? "Administrator" : "User"}</dd>
            <dt>Created</dt>
            <dd>{dateTime(me.created_at)}</dd>
          </dl>
          <div class="row-actions">
            <button type="button" class="btn" onClick={() => setDialog("password")}>
              Change password
            </button>
          </div>
        </section>
        <section class="card">
          <h2>Two-factor login</h2>
          <p>
            Status: {me.totp_enabled ? <Badge tone="ok">on</Badge> : <Badge>off</Badge>}
          </p>
          <p class="muted small">
            With two-factor login on, signing in here and in the RustDesk client also asks for a code from an authenticator app.
          </p>
          <div class="row-actions">
            {me.totp_enabled ? (
              <button type="button" class="btn btn-danger-ghost" onClick={() => setDialog("totp-off")}>
                Turn off
              </button>
            ) : (
              <button type="button" class="btn btn-primary" onClick={() => setDialog("totp-on")}>
                Set up
              </button>
            )}
          </div>
        </section>
      </div>

      <section class="card">
        <div class="card-head">
          <h2>My sessions</h2>
          <div class="row-actions">
            <button type="button" class="btn" disabled={busy} onClick={onSignOut}>
              Sign out
            </button>
            <button
              type="button"
              class="btn btn-danger-ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await Api.logoutEverywhere();
                  setToken(null);
                  onSignOut();
                })
              }
            >
              Sign out everywhere
            </button>
          </div>
        </div>
        <LoadView value={sessions}>
          {(list) =>
            list.length === 0 ? (
              <Empty>No sessions.</Empty>
            ) : (
              <ul class="session-list">
                {list.map((t) => (
                  <li key={t.token_hash}>
                    <div>
                      <div class="strong">{KIND_LABEL[t.kind]}</div>
                      <div class="muted small">{sessionDevice(t) || "—"}</div>
                    </div>
                    <div class="small right">
                      <div>last used {relativeTime(t.last_used_at)}</div>
                      <div class="muted">signed in {dateTime(t.created_at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </LoadView>
      </section>

      {dialog === "password" && <ChangePassword onClose={close} onDone={sessions.reload} />}
      {dialog === "totp-on" && <TotpSetup onClose={close} onDone={onChanged} />}
      {dialog === "totp-off" && <TotpDisable onClose={close} onDone={onChanged} />}
    </>
  );
}

function ChangePassword({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  return (
    <FormModal
      title="Change password"
      onClose={onClose}
      onSubmit={async () => {
        if (next.length < MIN_PASSWORD) throw new Error(`The new password must be at least ${MIN_PASSWORD} characters`);
        if (next !== repeat) throw new Error("The new passwords do not match");
        const { access_token } = await Api.changePassword(current, next);
        // The server ended every session, this one included, and issued a new token.
        setToken(access_token);
        toast("Password changed. Your other sessions were signed out.", "ok");
        onDone();
      }}
    >
      <TextField label="Current password" type="password" value={current} onInput={setCurrent} required autoComplete="current-password" />
      <TextField label="New password" type="password" value={next} onInput={setNext} required minLength={MIN_PASSWORD} autoComplete="new-password" hint="At least 8 characters." />
      <TextField label="Repeat new password" type="password" value={repeat} onInput={setRepeat} required autoComplete="new-password" />
    </FormModal>
  );
}

function TotpSetup({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const setup = useLoad(Api.totpSetup);
  const [code, setCode] = useState("");
  return (
    <FormModal
      title="Set up two-factor login"
      submitLabel="Turn on"
      onClose={onClose}
      onSubmit={async () => {
        if (!setup.data) throw new Error("The setup secret is not loaded yet");
        await Api.totpEnable(setup.data.secret, code.trim());
        toast("Two-factor login is on", "ok");
        onDone();
      }}
    >
      <LoadView value={setup}>
        {(s) => (
          <>
            <p class="muted small">Scan the code with an authenticator app (for example Aegis, Google Authenticator or 1Password), or enter the secret by hand.</p>
            <div class="totp-qr">
              <QrCode text={s.uri} label="QR code for your authenticator app" />
            </div>
            <div class="secret-box">
              <code class="break">{s.secret}</code>
              <CopyButton text={s.secret} label="Copy secret" />
            </div>
          </>
        )}
      </LoadView>
      <TextField label="Code from the app" value={code} onInput={setCode} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} required />
    </FormModal>
  );
}

function TotpDisable({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  return (
    <FormModal
      title="Turn off two-factor login"
      submitLabel="Turn off"
      onClose={onClose}
      onSubmit={async () => {
        await Api.totpDisable(code.trim());
        toast("Two-factor login is off", "ok");
        onDone();
      }}
    >
      <TextField label="Current code from your app" value={code} onInput={setCode} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} required />
    </FormModal>
  );
}

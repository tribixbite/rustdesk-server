/** Sign-in: password, optional TOTP second step, and OpenID Connect providers. */
import { useEffect, useRef, useState } from "preact/hooks";
import { Api, setToken } from "../api";
import { ErrorBox, errorText, TextField, ThemeButton } from "../ui";

const OIDC_POLL_MS = 1500;
const OIDC_TIMEOUT_MS = 3 * 60 * 1000;
const OIDC_PENDING = "No authed oidc is found";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  /** Set after step one when the account has two-factor login. */
  const [tfaSecret, setTfaSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [oidcWaiting, setOidcWaiting] = useState<string | null>(null);
  const cancelPoll = useRef<(() => void) | null>(null);

  useEffect(() => {
    Api.loginOptions()
      .then((opts) => setProviders(opts.filter((o) => o.startsWith("oidc/")).map((o) => o.slice(5))))
      .catch(() => setProviders([]));
    return () => cancelPoll.current?.();
  }, []);

  const finish = (token: string) => {
    setToken(token);
    onLogin();
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = tfaSecret ? await Api.loginTotp(tfaSecret, code.trim()) : await Api.login(username.trim(), password);
      if (r.type === "access_token") finish(r.access_token);
      else {
        setTfaSecret(r.secret);
        setCode("");
      }
    } catch (err) {
      setError(errorText(err));
      // An expired pending login cannot be retried with another code.
      if (tfaSecret && /expired/i.test(errorText(err))) setTfaSecret(null);
    } finally {
      setBusy(false);
    }
  };

  // TODO: exercise against a real OpenID provider; only the request shapes were checked against oidc.ts.
  const startOidc = async (op: string) => {
    setError(null);
    // Open the window synchronously in the click handler so popup blockers allow it.
    const win = window.open("about:blank", "_blank");
    try {
      const { code: oidcCode, url } = await Api.oidcAuth(op);
      if (win) win.location.href = url;
      else window.open(url, "_blank");
      setOidcWaiting(op);
      const started = Date.now();
      let stopped = false;
      cancelPoll.current = () => {
        stopped = true;
      };
      while (!stopped) {
        await new Promise((r) => setTimeout(r, OIDC_POLL_MS));
        if (stopped) break;
        if (Date.now() - started > OIDC_TIMEOUT_MS) throw new Error("Sign-in timed out, please try again");
        const r = await Api.oidcQuery(oidcCode);
        if (r.access_token) {
          finish(r.access_token);
          break;
        }
        if (r.error && r.error !== OIDC_PENDING) throw new Error(r.error);
      }
    } catch (err) {
      win?.close();
      setError(errorText(err));
    } finally {
      setOidcWaiting(null);
      cancelPoll.current = null;
    }
  };

  return (
    <main class="login">
      <div class="login-card">
        <ThemeButton class="login-theme" />
        <div class="brand brand-lg">
          <span class="brand-mark" aria-hidden="true">
            R
          </span>
          <span>
            RustDesk <span class="muted">Console</span>
          </span>
        </div>
        <form class="form" onSubmit={submit}>
          <h1 class="login-title">{tfaSecret ? "Two-factor code" : "Sign in"}</h1>
          {error && <ErrorBox message={error} />}
          {tfaSecret ? (
            <>
              <p class="muted">Enter the 6-digit code from your authenticator app.</p>
              <TextField
                label="Authentication code"
                value={code}
                onInput={setCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={8}
                required
                autoFocus
              />
            </>
          ) : (
            <>
              <TextField label="Username" value={username} onInput={setUsername} autoComplete="username" autoCapitalize="none" required autoFocus />
              <TextField label="Password" type="password" value={password} onInput={setPassword} autoComplete="current-password" required />
            </>
          )}
          <button type="submit" class="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Signing in…" : tfaSecret ? "Verify" : "Sign in"}
          </button>
          {tfaSecret && (
            <button type="button" class="btn btn-ghost btn-block" onClick={() => setTfaSecret(null)}>
              Back
            </button>
          )}
        </form>
        {!tfaSecret && providers.length > 0 && (
          <div class="oidc">
            <div class="divider">
              <span>or</span>
            </div>
            {oidcWaiting ? (
              <div class="stack">
                <p class="muted" role="status">
                  Finish signing in with {oidcWaiting} in the new window…
                </p>
                <button type="button" class="btn btn-block" onClick={() => cancelPoll.current?.()}>
                  Cancel
                </button>
              </div>
            ) : (
              providers.map((p) => (
                <button key={p} type="button" class="btn btn-block" onClick={() => void startOidc(p)}>
                  Continue with {p}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </main>
  );
}

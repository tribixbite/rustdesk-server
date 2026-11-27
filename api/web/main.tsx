/**
 * RustDesk API web console: app shell, session handling and hash routing
 * (#/devices etc., so deep links work without server-side routes).
 */
import "./styles.css";
import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { Api, getToken, onUnauthorized, setToken, type AdminUser } from "./api";
import { Account } from "./pages/account";
import { Audit, type AuditTab } from "./pages/audit";
import { Books } from "./pages/books";
import { Devices } from "./pages/devices";
import { Groups } from "./pages/groups";
import { Login } from "./pages/login";
import { Overview } from "./pages/overview";
import { Settings } from "./pages/settings";
import { Strategies } from "./pages/strategies";
import { Tokens } from "./pages/tokens";
import { Users } from "./pages/users";
import { applyTheme, getTheme } from "./theme";
import { ErrorBox, errorText, Icon, ThemeButton, Toasts, type IconName } from "./ui";

applyTheme(getTheme());

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  admin: boolean;
}

const NAV: readonly NavItem[] = [
  { path: "overview", label: "Overview", icon: "overview", admin: true },
  { path: "devices", label: "Devices", icon: "devices", admin: true },
  { path: "users", label: "Users", icon: "users", admin: true },
  { path: "groups", label: "Device groups", icon: "groups", admin: true },
  { path: "strategies", label: "Strategies", icon: "strategies", admin: true },
  { path: "address-books", label: "Address books", icon: "books", admin: true },
  { path: "audit", label: "Audit log", icon: "audit", admin: true },
  { path: "tokens", label: "Sessions & tokens", icon: "tokens", admin: true },
  { path: "settings", label: "Settings", icon: "settings", admin: true },
  { path: "account", label: "My account", icon: "account", admin: false },
];

/** The route segments after "#/", e.g. ["audit", "file"]. */
function readHash(): string[] {
  return window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

function useHashRoute(): string[] {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const f = () => setRoute(readHash());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return route;
}

type Session = { state: "checking" } | { state: "signed-out" } | { state: "signed-in"; me: AdminUser } | { state: "error"; message: string };

function App() {
  const [session, setSession] = useState<Session>(() => (getToken() ? { state: "checking" } : { state: "signed-out" }));

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setSession({ state: "signed-out" });
      return;
    }
    try {
      setSession({ state: "signed-in", me: await Api.me() });
    } catch (e) {
      // A 401 already cleared the token via onUnauthorized.
      if (getToken()) setSession({ state: "error", message: errorText(e) });
    }
  }, []);

  useEffect(() => {
    const off = onUnauthorized(() => setSession({ state: "signed-out" }));
    void loadMe();
    return off;
  }, [loadMe]);

  const signOut = useCallback(async () => {
    // "Sign out everywhere" has already ended the session and cleared the token.
    if (getToken()) await Api.logout().catch(() => undefined);
    setToken(null);
    setSession({ state: "signed-out" });
  }, []);

  if (session.state === "checking") return <div class="loading full">Loading…</div>;
  if (session.state === "signed-out")
    return (
      <>
        <Login onLogin={() => void loadMe()} />
        <Toasts />
      </>
    );
  if (session.state === "error")
    return (
      <main class="login">
        <div class="login-card stack">
          <ErrorBox message={session.message} onRetry={() => void loadMe()} />
          <button type="button" class="btn btn-block" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </main>
    );
  return <Shell me={session.me} onMeChanged={() => void loadMe()} onSignOut={() => void signOut()} />;
}

function Shell({ me, onMeChanged, onSignOut }: { me: AdminUser; onMeChanged: () => void; onSignOut: () => void }) {
  const route = useHashRoute();
  const [drawer, setDrawer] = useState(false);
  const items = NAV.filter((n) => me.is_admin || !n.admin);
  const fallback = me.is_admin ? "overview" : "account";
  const requested = route[0] ?? fallback;
  const current = items.some((n) => n.path === requested) ? requested : fallback;
  const currentItem = items.find((n) => n.path === current);

  // Close the phone drawer after navigating, and move focus to the page heading.
  useEffect(() => {
    setDrawer(false);
    window.scrollTo(0, 0);
    document.title = `${currentItem?.label ?? "Console"} · RustDesk`;
    requestAnimationFrame(() => document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true }));
  }, [current, route[1]]);

  useEffect(() => {
    if (!drawer) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [drawer]);

  const auditTab: AuditTab = route[1] === "file" || route[1] === "alarm" ? route[1] : "conn";

  return (
    <div class={drawer ? "shell drawer-open" : "shell"}>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <header class="topbar">
        <button
          type="button"
          class="btn btn-icon btn-ghost menu-btn"
          aria-label="Menu"
          aria-expanded={drawer}
          aria-controls="sidebar"
          onClick={() => setDrawer(!drawer)}
        >
          <Icon name={drawer ? "close" : "menu"} />
        </button>
        <span class="brand">
          <span class="brand-mark" aria-hidden="true">
            R
          </span>
          <span>{currentItem?.label ?? "RustDesk"}</span>
        </span>
      </header>
      <div class="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      <nav id="sidebar" class="sidebar" aria-label="Main">
        <div class="sidebar-top">
          <div class="brand sidebar-brand">
            <span class="brand-mark" aria-hidden="true">
              R
            </span>
            <span>RustDesk</span>
          </div>
          <ThemeButton />
        </div>
        <ul class="nav-list">
          {items.map((n) => (
            <li key={n.path}>
              <a href={`#/${n.path}`} class={n.path === current ? "nav-link active" : "nav-link"} aria-current={n.path === current ? "page" : undefined}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
              </a>
            </li>
          ))}
          <li>
            <a href="/docs" target="_blank" rel="noopener" class="nav-link">
              <Icon name="docs" />
              <span>API docs</span>
            </a>
          </li>
        </ul>
        <div class="sidebar-foot">
          <div class="me">
            <span class="avatar" aria-hidden="true">
              {(me.display_name || me.name).slice(0, 1).toUpperCase()}
            </span>
            <span class="me-name">
              <span class="strong">{me.display_name || me.name}</span>
              <span class="muted small">
                {me.name}
                {me.is_admin ? " · admin" : ""}
              </span>
            </span>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="Sign out" title="Sign out" onClick={onSignOut}>
            <Icon name="logout" />
          </button>
        </div>
      </nav>
      <main id="main" class="content" tabIndex={-1}>
        {current === "overview" && <Overview />}
        {current === "devices" && <Devices />}
        {current === "users" && <Users />}
        {current === "groups" && <Groups />}
        {current === "strategies" && <Strategies />}
        {current === "address-books" && <Books />}
        {current === "audit" && <Audit tab={auditTab} />}
        {current === "tokens" && <Tokens />}
        {current === "settings" && <Settings />}
        {current === "account" && <Account me={me} onChanged={onMeChanged} onSignOut={onSignOut} />}
      </main>
      <Toasts />
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);

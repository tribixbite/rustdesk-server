/**
 * Shared console building blocks: data loading, dialogs, toasts, copy buttons,
 * form fields, QR codes and time formatting.
 */
import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { getTheme, setTheme, THEMES, type Theme } from "./theme";

// ---- data loading ----

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` on mount and whenever `deps` change; `reload()` refetches. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load()
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(errorText(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // `load` is deliberately not a dependency: callers list what it reads in `deps`.
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Wraps an async action: tracks `busy`, shows failures as a toast and returns
 * whether the action succeeded.
 */
export function useAction(): [boolean, (f: () => Promise<unknown>, success?: string) => Promise<boolean>] {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (f: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await f();
      if (success) toast(success, "ok");
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy, run];
}

/** Renders the loading / error states of a Loaded value, or `children(data)`. */
export function LoadView<T>({ value, children }: { value: Loaded<T>; children: (data: T) => ComponentChildren }) {
  if (value.data === undefined) {
    if (value.error) return <ErrorBox message={value.error} onRetry={value.reload} />;
    return <div class="loading" role="status" aria-live="polite">Loading…</div>;
  }
  return (
    <>
      {value.error && <ErrorBox message={value.error} onRetry={value.reload} />}
      {children(value.data)}
    </>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="alert alert-error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" class="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

// ---- toasts ----

type ToastKind = "ok" | "error" | "info";
interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

let toastSeq = 0;
let toastItems: ToastItem[] = [];
const toastListeners = new Set<(items: ToastItem[]) => void>();

function setToasts(items: ToastItem[]): void {
  toastItems = items;
  for (const f of toastListeners) f(items);
}

/** Shows a short message at the bottom of the screen for a few seconds. */
export function toast(text: string, kind: ToastKind = "info"): void {
  const id = ++toastSeq;
  setToasts([...toastItems, { id, text, kind }]);
  setTimeout(() => setToasts(toastItems.filter((t) => t.id !== id)), kind === "error" ? 6000 : 3000);
}

export function Toasts() {
  const [items, setItems] = useState(toastItems);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => void toastListeners.delete(setItems);
  }, []);
  return (
    <div class="toasts" aria-live="polite" aria-atomic="false">
      {items.map((t) => (
        <div key={t.id} class={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---- dialogs ----

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  /** Buttons shown at the bottom; a form inside `children` may submit instead. */
  footer?: ComponentChildren;
  wide?: boolean;
}

/**
 * A modal built on the native <dialog>: showModal() gives focus trapping,
 * Escape to close and an inert background.
 */
export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      d.showModal();
      // showModal() focuses the first button (Close) and draws its focus ring;
      // focus the dialog content instead so Tab starts from the top.
      d.querySelector<HTMLElement>(".modal-inner")?.focus();
    }
    const cancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener("cancel", cancel);
    return () => {
      d.removeEventListener("cancel", cancel);
      if (d.open) d.close();
    };
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      class={wide ? "modal modal-wide" : "modal"}
      aria-labelledby={titleId}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current) onClose();
      }}
    >
      <div class="modal-inner" tabIndex={-1}>
        <header class="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" class="btn btn-icon btn-ghost" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div class="modal-body">{children}</div>
        {footer && <footer class="modal-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

interface ConfirmProps {
  title: string;
  message: ComponentChildren;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}

/** Asks before a destructive action; closes after `onConfirm` succeeds. */
export function Confirm({ title, message, confirmLabel = "Delete", danger = true, onConfirm, onClose }: ConfirmProps) {
  const [busy, run] = useAction();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            class={danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy}
            onClick={async () => {
              if (await run(onConfirm)) onClose();
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}

/**
 * A dialog wrapping a <form>: the submit button lives in the footer but is
 * associated with the form through its id, so Enter submits too.
 */
export function FormModal({
  title,
  onClose,
  onSubmit,
  submitLabel = "Save",
  children,
  wide,
  extraFooter,
}: {
  title: string;
  onClose: () => void;
  /** Return true (or nothing) to close the dialog. */
  onSubmit: () => Promise<boolean | void>;
  submitLabel?: string;
  children: ComponentChildren;
  wide?: boolean;
  extraFooter?: ComponentChildren;
}) {
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const keepOpen = (await onSubmit()) === false;
      if (!keepOpen) onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide={wide}
      footer={
        <>
          {extraFooter}
          <span class="spacer" />
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} class="btn btn-primary" disabled={busy}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </>
      }
    >
      <form id={formId} class="form" onSubmit={submit} noValidate={false}>
        {error && <ErrorBox message={error} />}
        {children}
      </form>
    </Modal>
  );
}

// ---- form fields ----

type InputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "value" | "onInput" | "label">;

export function TextField({
  label,
  value,
  onInput,
  hint,
  ...rest
}: { label: string; value: string; onInput: (v: string) => void; hint?: string } & InputProps) {
  const id = useId();
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <input id={id} value={value} onInput={(e) => onInput(e.currentTarget.value)} aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
      {hint && (
        <small id={`${id}-hint`} class="hint">
          {hint}
        </small>
      )}
    </div>
  );
}

export function TextArea({ label, value, onInput, rows = 3 }: { label: string; value: string; onInput: (v: string) => void; rows?: number }) {
  const id = useId();
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <textarea id={id} rows={rows} value={value} onInput={(e) => onInput(e.currentTarget.value)} />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (v: string) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <small class="hint">{hint}</small>}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div class="check">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      <label for={id}>
        {label}
        {hint && <small class="hint">{hint}</small>}
      </label>
    </div>
  );
}

/** "" in a select means none; maps to null for the API. */
export function idOrNull(v: string): number | null {
  if (v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// ---- copy ----

/**
 * Copies text. navigator.clipboard needs a secure context, which a self-hosted
 * console on plain http over the LAN is not, so fall back to execCommand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      class="btn btn-small"
      aria-label={`${label}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } else toast("Copy failed; select the text and copy it manually", "error");
      }}
    >
      <Icon name={done ? "check" : "copy"} />
      <span>{done ? "Copied" : label}</span>
    </button>
  );
}

/** A label, a monospaced value that wraps anywhere, and a copy button. */
export function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="copy-row">
      <div class="copy-row-text">
        <div class="copy-row-label">{label}</div>
        <code class="copy-row-value">{value || "—"}</code>
      </div>
      {value && <CopyButton text={value} />}
    </div>
  );
}

// ---- QR ----

/** An SVG QR code of `text`, dark modules on white so phone cameras read it in either theme. */
export function QrCode({ text, label }: { text: string; label: string }) {
  let svg = "";
  try {
    const qr = qrcode(0, "M");
    qr.addData(text, "Byte");
    qr.make();
    svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  } catch (e) {
    return <ErrorBox message={`Cannot draw QR code: ${errorText(e)}`} />;
  }
  return <div class="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

// ---- time ----

/** Local date and time for a unix timestamp in seconds. */
export function dateTime(sec: number | null | undefined): string {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const rtf = typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;

/** "3 minutes ago" for a unix timestamp in seconds. */
export function relativeTime(sec: number | null | undefined): string {
  if (!sec) return "never";
  const diff = sec - Date.now() / 1000;
  const abs = Math.abs(diff);
  const steps: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [86400 * 30, "day"],
    [86400 * 365, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  const sizes: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, month: 86400 * 30, year: 86400 * 365 };
  for (const [limit, unit] of steps) {
    if (abs < limit) {
      const n = Math.round(diff / (sizes[unit] ?? 1));
      return rtf ? rtf.format(n, unit) : `${Math.abs(n)} ${unit}s ${n < 0 ? "ago" : "from now"}`;
    }
  }
  return dateTime(sec);
}

// ---- layout bits ----

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ComponentChildren }) {
  return (
    <div class="page-head">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {subtitle && <p class="muted">{subtitle}</p>}
      </div>
      {actions && <div class="page-actions">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="empty">{children}</div>;
}

export function Badge({ children, tone = "neutral" }: { children: ComponentChildren; tone?: "neutral" | "ok" | "warn" | "danger" | "accent" }) {
  return <span class={`badge badge-${tone}`}>{children}</span>;
}

/** Search box that filters a list client-side. */
export function SearchBox({ value, onInput, placeholder }: { value: string; onInput: (v: string) => void; placeholder: string }) {
  return (
    <div class="search">
      <Icon name="search" />
      <input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onInput={(e) => onInput(e.currentTarget.value)} />
    </div>
  );
}

/** Case-insensitive "any of these fields contains the query". */
export function matches(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}

// ---- tables ----

export interface Column<T> {
  label: string;
  render: (row: T) => ComponentChildren;
  /** Extra class on the cell, e.g. "num" or "mono". */
  cls?: string;
  /** Shown as the card title on narrow screens. */
  primary?: boolean;
}

/**
 * A table on wide screens; under 720px each row becomes a stacked card whose
 * cells are labelled from `data-label` (see .table in styles.css).
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  actions,
  caption,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T) => string | number;
  actions?: (row: T) => ComponentChildren;
  caption?: string;
}) {
  return (
    <div class="table-wrap">
      <table class="table">
        {caption && <caption class="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} scope="col" class={c.cls}>
                {c.label}
              </th>
            ))}
            {actions && (
              <th scope="col" class="actions-col">
                <span class="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.label} data-label={c.label} class={[c.cls, c.primary ? "primary" : ""].filter(Boolean).join(" ") || undefined}>
                  {c.render(r)}
                </td>
              ))}
              {actions && <td class="actions">{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Previous / next paging for {total, data} lists. */
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav class="pager" aria-label="Pages">
      <button type="button" class="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span class="muted" aria-live="polite">
        Page {page} of {pages} · {total} total
      </span>
      <button type="button" class="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}

// ---- theme ----

const THEME_LABEL: Record<Theme, string> = { dark: "Dark", light: "Light", system: "System" };
const THEME_ICON: Record<Theme, IconName> = { dark: "moon", light: "sun", system: "auto" };

/** Cycles dark → light → system; the label names the current choice. */
export function ThemeButton({ class: cls }: { class?: string }) {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "dark";
  return (
    <button
      type="button"
      class={`btn btn-ghost btn-icon${cls ? ` ${cls}` : ""}`}
      aria-label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[next]}`}
      title={`Theme: ${THEME_LABEL[theme]}`}
      onClick={() => {
        setTheme(next);
        setThemeState(next);
      }}
    >
      <Icon name={THEME_ICON[theme]} />
    </button>
  );
}

// ---- icons ----

/** Inline 24px stroke icons (no icon font, nothing to fetch). */
const ICONS = {
  overview: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  devices: "M3 5h18v11H3zM8 20h8M12 16v4",
  users: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  groups: "M3 7h7l2 2h9v10H3z",
  strategies: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  books: "M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4zM4 16a4 4 0 0 1 4-4h12",
  audit: "M9 5h10M9 12h10M9 19h10M4 5h1M4 12h1M4 19h1",
  tokens: "M15 7a4 4 0 1 1-3.5 6L4 20.5V17h3v-3h3l1.5-1.5A4 4 0 0 1 15 7zM16 10h0",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  account: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  docs: "M14 3h7v7M10 14L21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5",
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "M6 6l12 12M18 6L6 18",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "M5 12l5 5L20 7",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  plus: "M12 5v14M5 12h14",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  auto: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Audit log: connections, file transfers and security alarms, paged. */
import { useState } from "preact/hooks";
import { Api, type AlarmAudit, type ConnAudit, type FileAudit, type Page } from "../api";
import { Badge, DataTable, dateTime, Empty, LoadView, PageHead, Pager, useLoad, type Column } from "../ui";

export const CONN_TYPES: Readonly<Record<number, string>> = {
  0: "Remote desktop",
  1: "File transfer",
  2: "Port forward",
  3: "View camera",
  4: "Terminal",
};

export const PRIMARY_AUTH: Readonly<Record<number, string>> = {
  1: "Click to accept",
  2: "One-time password",
  3: "Permanent password",
  4: "Switch sides",
};

const PAGE_SIZE = 50;

export type AuditTab = "conn" | "file" | "alarm";
const TABS: ReadonlyArray<{ id: AuditTab; label: string }> = [
  { id: "conn", label: "Connections" },
  { id: "file", label: "Files" },
  { id: "alarm", label: "Alarms" },
];

export function Audit({ tab }: { tab: AuditTab }) {
  return (
    <>
      <PageHead title="Audit log" subtitle="What clients reported. Old entries are removed after the retention period in Settings." />
      <div class="tabs" role="tablist" aria-label="Audit log">
        {TABS.map((t) => (
          <a key={t.id} role="tab" aria-selected={t.id === tab} class={t.id === tab ? "tab active" : "tab"} href={`#/audit/${t.id}`}>
            {t.label}
          </a>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "conn" && <PagedList key="conn" load={Api.connAudit} columns={CONN_COLUMNS} rowKey={(r) => r.guid} empty="No connections recorded yet." />}
        {tab === "file" && <PagedList key="file" load={Api.fileAudit} columns={FILE_COLUMNS} rowKey={(r) => r.id} empty="No file transfers recorded yet." />}
        {tab === "alarm" && <PagedList key="alarm" load={Api.alarmAudit} columns={ALARM_COLUMNS} rowKey={(r) => r.id} empty="No alarms. Good." />}
      </div>
    </>
  );
}

function PagedList<T>({
  load,
  columns,
  rowKey,
  empty,
}: {
  load: (page: number, size: number) => Promise<Page<T>>;
  columns: ReadonlyArray<Column<T>>;
  rowKey: (r: T) => string | number;
  empty: string;
}) {
  const [page, setPage] = useState(1);
  const list = useLoad(() => load(page, PAGE_SIZE), [page]);
  return (
    <LoadView value={list}>
      {(p) =>
        p.total === 0 ? (
          <Empty>{empty}</Empty>
        ) : (
          <>
            <DataTable rows={p.data} columns={columns} rowKey={rowKey} />
            <Pager page={page} pageSize={PAGE_SIZE} total={p.total} onPage={setPage} />
          </>
        )
      }
    </LoadView>
  );
}

/** Short JSON for the free-form `info` objects clients send. */
function infoText(info: unknown): string {
  if (info === null || info === undefined) return "";
  if (typeof info === "object" && Object.keys(info).length === 0) return "";
  return typeof info === "string" ? info : JSON.stringify(info);
}

function duration(from: number | null, to: number | null): string {
  if (!from || !to) return "";
  const s = Math.max(0, to - from);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

const CONN_COLUMNS: ReadonlyArray<Column<ConnAudit>> = [
  { label: "Started", primary: true, render: (r) => dateTime(r.created_at) },
  { label: "Device", render: (r) => <span class="mono">{r.device_id}</span> },
  {
    label: "From",
    render: (r) => (
      <div>
        <div>{r.peer_name || r.peer_id || "—"}</div>
        {r.peer_name && r.peer_id && <div class="mono muted small">{r.peer_id}</div>}
        {r.ip && <div class="mono muted small">{r.ip}</div>}
      </div>
    ),
  },
  { label: "Type", render: (r) => (r.conn_type === null ? "—" : (CONN_TYPES[r.conn_type] ?? `type ${r.conn_type}`)) },
  {
    label: "Auth",
    render: (r) => (
      <span>
        {r.primary_auth === null ? "—" : (PRIMARY_AUTH[r.primary_auth] ?? `type ${r.primary_auth}`)}
        {r.two_factor ? <span class="muted small"> + 2FA</span> : null}
      </span>
    ),
  },
  {
    label: "Ended",
    render: (r) =>
      r.closed_at ? (
        <span>
          {dateTime(r.closed_at)} <span class="muted small">({duration(r.created_at, r.closed_at)})</span>
        </span>
      ) : (
        <Badge tone="ok">open</Badge>
      ),
  },
  { label: "Note", render: (r) => r.note || <span class="muted">—</span> },
];

const FILE_COLUMNS: ReadonlyArray<Column<FileAudit>> = [
  { label: "Time", primary: true, render: (r) => dateTime(r.created_at) },
  { label: "Device", render: (r) => <span class="mono">{r.device_id}</span> },
  { label: "Peer", render: (r) => <span class="mono">{r.peer_id || "—"}</span> },
  { label: "Direction", render: (r) => (r.type === 0 ? "Sent from device" : "Received by device") },
  { label: "Path", render: (r) => <span class="mono break small">{r.path || "—"}{r.is_file ? "" : " (folder)"}</span> },
  { label: "Details", render: (r) => <span class="mono break small">{infoText(r.info) || "—"}</span> },
];

const ALARM_COLUMNS: ReadonlyArray<Column<AlarmAudit>> = [
  { label: "Time", primary: true, render: (r) => dateTime(r.created_at) },
  { label: "Device", render: (r) => <span class="mono">{r.device_id}</span> },
  { label: "Alarm", render: (r) => <Badge tone="danger">{r.typ_name}</Badge> },
  { label: "Details", render: (r) => <span class="mono break small">{infoText(r.info) || "—"}</span> },
];

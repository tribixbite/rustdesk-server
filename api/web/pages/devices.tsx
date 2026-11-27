/** Devices: status, owner, group, strategy; edit, disconnect live sessions, delete. */
import { useState } from "preact/hooks";
import { Api, type AdminUser, type Device, type DeviceGroup, type Strategy } from "../api";
import {
  Badge,
  Checkbox,
  Confirm,
  DataTable,
  Empty,
  FormModal,
  Icon,
  idOrNull,
  LoadView,
  matches,
  PageHead,
  relativeTime,
  SearchBox,
  SelectField,
  TextArea,
  TextField,
  useAction,
  useLoad,
  dateTime,
  type Column,
} from "../ui";

interface Lookups {
  devices: Device[];
  users: AdminUser[];
  groups: DeviceGroup[];
  strategies: Strategy[];
}

async function loadAll(): Promise<Lookups> {
  const [devices, users, groups, strategies] = await Promise.all([Api.devices(), Api.users(), Api.groups(), Api.strategies()]);
  return { devices, users, groups, strategies };
}

export const deviceName = (d: Device) => d.device_name || d.hostname || "—";

/** The client reports "windows / Windows 11 Pro"; the part after the slash reads better. */
const osName = (os: string) => os.split(" / ").pop()?.trim() || os;

export function Devices() {
  const all = useLoad(loadAll);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState<Device | null>(null);
  // A live session to close, after confirmation (it ends someone's remote session).
  const [disconnecting, setDisconnecting] = useState<{ device: Device; conn: number } | null>(null);
  const [busy, run] = useAction();

  return (
    <>
      <PageHead
        title="Devices"
        subtitle="Every machine that has reported to this server."
        actions={
          <button type="button" class="btn" onClick={all.reload} disabled={all.loading}>
            {all.loading ? "Refreshing…" : "Refresh"}
          </button>
        }
      />
      <LoadView value={all}>
        {(l) => {
          const groupName = (id: number | null) => l.groups.find((g) => g.id === id)?.name ?? "";
          const rows = l.devices.filter((d) => matches(query, d.id, d.device_name, d.hostname, d.os, d.owner?.name, d.note, groupName(d.device_group_id)));
          const columns: Array<Column<Device>> = [
            {
              label: "Device",
              primary: true,
              render: (d) => (
                <div class="cell-title">
                  <span class={d.online ? "dot dot-on" : "dot"} role="img" aria-label={d.online ? "Online" : "Offline"} />
                  <div>
                    <div class="strong">{deviceName(d)}</div>
                    <div class="mono muted small">{d.id}</div>
                  </div>
                </div>
              ),
            },
            {
              label: "System",
              render: (d) => (
                <div class="small">
                  <div title={d.os}>{d.os ? osName(d.os) : "—"}</div>
                  {d.version && <div class="muted">RustDesk {d.version}</div>}
                </div>
              ),
            },
            { label: "Owner", render: (d) => d.owner?.name ?? <span class="muted">—</span> },
            { label: "Group", render: (d) => groupName(d.device_group_id) || <span class="muted">—</span> },
            { label: "Strategy", render: (d) => d.effective_strategy ?? <span class="muted">—</span> },
            {
              // Online state, last contact and live sessions in one cell keeps the table narrow.
              label: "Status",
              render: (d) => (
                <div class="status-cell">
                  {d.online ? (
                    <Badge tone="ok">online</Badge>
                  ) : (
                    <span class="small" title={dateTime(d.last_online)}>
                      {relativeTime(d.last_online)}
                    </span>
                  )}
                  {d.conns.length > 0 && (
                    <div class="chips" aria-label="Live sessions">
                      {d.conns.map((c) => (
                        <button
                          key={c}
                          type="button"
                          class="chip"
                          disabled={busy}
                          aria-label={`Disconnect session ${c}`}
                          title="Disconnect this session"
                          onClick={() => setDisconnecting({ device: d, conn: c })}
                        >
                          #{c} <Icon name="close" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ),
            },
          ];
          return (
            <>
              <div class="toolbar">
                <SearchBox value={query} onInput={setQuery} placeholder="Search devices" />
                <span class="muted small">
                  {l.devices.filter((d) => d.online).length} of {l.devices.length} online
                </span>
              </div>
              {rows.length === 0 ? (
                <Empty>{l.devices.length === 0 ? "No devices yet. They appear after a client with this API server reports in." : "No device matches."}</Empty>
              ) : (
                <DataTable
                  caption="Devices"
                  rows={rows}
                  columns={columns}
                  rowKey={(d) => d.id}
                  actions={(d) => (
                    <>
                      <button type="button" class="btn btn-small" onClick={() => setEditing(d)}>
                        <Icon name="edit" />
                        <span>Edit</span>
                      </button>
                      <button type="button" class="btn btn-small btn-danger-ghost" aria-label={`Delete ${d.id}`} onClick={() => setDeleting(d)}>
                        <Icon name="trash" />
                      </button>
                    </>
                  )}
                />
              )}
              {editing && <EditDevice device={editing} lookups={l} onClose={() => setEditing(null)} onSaved={all.reload} />}
              {disconnecting && (
                <Confirm
                  title="Disconnect session"
                  message={`End session #${disconnecting.conn} on ${deviceName(disconnecting.device)}? It closes on the device's next heartbeat (within about 15 seconds).`}
                  confirmLabel="Disconnect"
                  onConfirm={async () => {
                    await run(() => Api.disconnect(disconnecting.device.id, disconnecting.conn), `Session ${disconnecting.conn} will close on the next heartbeat`);
                  }}
                  onClose={() => setDisconnecting(null)}
                />
              )}
              {deleting && (
                <Confirm
                  title="Delete device"
                  message={`Forget ${deviceName(deleting)} (${deleting.id})? It reappears if the client reports again.`}
                  onConfirm={async () => {
                    await Api.deleteDevice(deleting.id);
                    all.reload();
                  }}
                  onClose={() => setDeleting(null)}
                />
              )}
            </>
          );
        }}
      </LoadView>
    </>
  );
}

function EditDevice({ device, lookups, onClose, onSaved }: { device: Device; lookups: Lookups; onClose: () => void; onSaved: () => void }) {
  const [owner, setOwner] = useState(device.owner?.guid ?? "");
  const [group, setGroup] = useState(device.device_group_id?.toString() ?? "");
  const [strategy, setStrategy] = useState(device.strategy_id?.toString() ?? "");
  const [name, setName] = useState(device.device_name);
  const [note, setNote] = useState(device.note);
  const [clearUuid, setClearUuid] = useState(false);
  const [requestSysinfo, setRequestSysinfo] = useState(false);

  return (
    <FormModal
      title={`Edit ${deviceName(device)}`}
      onClose={onClose}
      onSubmit={async () => {
        await Api.updateDevice(device.id, {
          user_guid: owner === "" ? null : owner,
          device_group_id: idOrNull(group),
          strategy_id: idOrNull(strategy),
          device_name: name,
          note,
          clear_uuid: clearUuid || undefined,
          request_sysinfo: requestSysinfo || undefined,
        });
        onSaved();
      }}
    >
      <dl class="facts">
        <dt>ID</dt>
        <dd class="mono">{device.id}</dd>
        <dt>Hostname</dt>
        <dd>{device.hostname || "—"}</dd>
        <dt>OS user</dt>
        <dd>{device.username || "—"}</dd>
        <dt>Hardware</dt>
        <dd>{[device.cpu, device.memory].filter(Boolean).join(" · ") || "—"}</dd>
        <dt>First seen</dt>
        <dd>{dateTime(device.created_at)}</dd>
      </dl>
      <TextField label="Display name" value={name} onInput={setName} placeholder={device.hostname} hint="Empty uses the hostname." />
      <SelectField
        label="Owner"
        value={owner}
        onChange={setOwner}
        options={[{ value: "", label: "No owner" }, ...lookups.users.map((u) => ({ value: u.guid, label: u.display_name ? `${u.name} (${u.display_name})` : u.name }))]}
      />
      <SelectField
        label="Device group"
        value={group}
        onChange={setGroup}
        options={[{ value: "", label: "No group" }, ...lookups.groups.map((g) => ({ value: String(g.id), label: g.name }))]}
      />
      <SelectField
        label="Strategy"
        value={strategy}
        onChange={setStrategy}
        hint="Empty inherits from the group, then the owner."
        options={[{ value: "", label: "Inherit" }, ...lookups.strategies.map((s) => ({ value: String(s.id), label: s.name }))]}
      />
      <TextArea label="Note" value={note} onInput={setNote} />
      {device.uuid_bound && (
        <Checkbox
          label="Forget the bound machine"
          hint="Use after reinstalling, so the device can report from its new installation."
          checked={clearUuid}
          onChange={setClearUuid}
        />
      )}
      <Checkbox label="Ask the client to resend its system info" checked={requestSysinfo} onChange={setRequestSysinfo} />
    </FormModal>
  );
}

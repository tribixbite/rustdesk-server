/** Device groups: name, note, strategy and the users who may see the group's devices. */
import { useState } from "preact/hooks";
import { Api, type AdminUser, type DeviceGroup, type Strategy } from "../api";
import { Confirm, DataTable, Empty, FormModal, Icon, idOrNull, LoadView, PageHead, SelectField, TextArea, TextField, useLoad, type Column } from "../ui";

async function loadAll() {
  const [groups, users, strategies, devices] = await Promise.all([Api.groups(), Api.users(), Api.strategies(), Api.devices()]);
  return { groups, users, strategies, devices };
}

export function Groups() {
  const all = useLoad(loadAll);
  const [editing, setEditing] = useState<DeviceGroup | "new" | null>(null);
  const [deleting, setDeleting] = useState<DeviceGroup | null>(null);
  return (
    <>
      <PageHead
        title="Device groups"
        subtitle="Group devices, give them a strategy and choose who may see them."
        actions={
          <button type="button" class="btn btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            <span>New group</span>
          </button>
        }
      />
      <LoadView value={all}>
        {({ groups, users, strategies, devices }) => {
          const userName = (guid: string) => users.find((u) => u.guid === guid)?.name ?? guid;
          const columns: Array<Column<DeviceGroup>> = [
            {
              label: "Group",
              primary: true,
              render: (g) => (
                <div>
                  <div class="strong">{g.name}</div>
                  {g.note && <div class="muted small">{g.note}</div>}
                </div>
              ),
            },
            { label: "Devices", cls: "num", render: (g) => devices.filter((d) => d.device_group_id === g.id).length },
            { label: "Strategy", render: (g) => strategies.find((s) => s.id === g.strategy_id)?.name ?? <span class="muted">—</span> },
            {
              label: "Visible to",
              render: (g) => (g.user_guids.length === 0 ? <span class="muted">administrators only</span> : g.user_guids.map(userName).join(", ")),
            },
          ];
          return (
            <>
              {groups.length === 0 ? (
                <Empty>No device groups yet.</Empty>
              ) : (
                <DataTable
                  caption="Device groups"
                  rows={groups}
                  columns={columns}
                  rowKey={(g) => g.id}
                  actions={(g) => (
                    <>
                      <button type="button" class="btn btn-small" onClick={() => setEditing(g)}>
                        <Icon name="edit" />
                        <span>Edit</span>
                      </button>
                      <button type="button" class="btn btn-small btn-danger-ghost" aria-label={`Delete ${g.name}`} onClick={() => setDeleting(g)}>
                        <Icon name="trash" />
                      </button>
                    </>
                  )}
                />
              )}
              {editing && (
                <EditGroup group={editing === "new" ? null : editing} users={users} strategies={strategies} onClose={() => setEditing(null)} onSaved={all.reload} />
              )}
              {deleting && (
                <Confirm
                  title="Delete device group"
                  message={`Delete “${deleting.name}”? Its devices stay, without a group.`}
                  onConfirm={async () => {
                    await Api.deleteGroup(deleting.id);
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

function EditGroup({
  group,
  users,
  strategies,
  onClose,
  onSaved,
}: {
  group: DeviceGroup | null;
  users: AdminUser[];
  strategies: Strategy[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [note, setNote] = useState(group?.note ?? "");
  const [strategy, setStrategy] = useState(group?.strategy_id?.toString() ?? "");
  const [members, setMembers] = useState<ReadonlySet<string>>(new Set(group?.user_guids ?? []));
  const toggle = (guid: string, on: boolean) => {
    const next = new Set(members);
    if (on) next.add(guid);
    else next.delete(guid);
    setMembers(next);
  };
  return (
    <FormModal
      title={group ? `Edit ${group.name}` : "New device group"}
      submitLabel={group ? "Save" : "Create"}
      onClose={onClose}
      onSubmit={async () => {
        const body = { name: name.trim(), note, strategy_id: idOrNull(strategy), user_guids: [...members] };
        if (group) await Api.updateGroup(group.id, body);
        else await Api.createGroup(body);
        onSaved();
      }}
    >
      <TextField label="Name" value={name} onInput={setName} required />
      <TextArea label="Note" value={note} onInput={setNote} rows={2} />
      <SelectField
        label="Strategy"
        value={strategy}
        onChange={setStrategy}
        hint="Applies to devices in this group that have no strategy of their own."
        options={[{ value: "", label: "None" }, ...strategies.map((s) => ({ value: String(s.id), label: s.name }))]}
      />
      <fieldset class="field">
        <legend>Users who may see these devices</legend>
        {users.length === 0 ? (
          <p class="muted small">No users.</p>
        ) : (
          <div class="checklist">
            {users.map((u) => (
              <label key={u.guid} class="check-item">
                <input type="checkbox" checked={members.has(u.guid)} onChange={(e) => toggle(u.guid, e.currentTarget.checked)} />
                <span>
                  {u.name}
                  {u.display_name && <span class="muted small"> · {u.display_name}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </FormModal>
  );
}

/** Users: create, edit, enable/disable, reset password or 2FA, assign a strategy, delete. */
import { useState } from "preact/hooks";
import { Api, type AdminUser, type Strategy, type UserStatus } from "../api";
import {
  Badge,
  Checkbox,
  Confirm,
  DataTable,
  dateTime,
  Empty,
  FormModal,
  Icon,
  idOrNull,
  LoadView,
  matches,
  PageHead,
  SearchBox,
  SelectField,
  TextArea,
  TextField,
  useAction,
  useLoad,
  type Column,
} from "../ui";

const STATUS: Record<UserStatus, { label: string; tone: "ok" | "danger" | "warn" }> = {
  1: { label: "active", tone: "ok" },
  0: { label: "disabled", tone: "danger" },
  [-1]: { label: "unverified", tone: "warn" },
};

const MIN_PASSWORD = 8;

async function loadAll() {
  const [users, strategies, me] = await Promise.all([Api.users(), Api.strategies(), Api.me()]);
  return { users, strategies, me };
}

type Dialog =
  | { kind: "create" }
  | { kind: "edit"; user: AdminUser }
  | { kind: "password"; user: AdminUser }
  | { kind: "totp"; user: AdminUser }
  | { kind: "delete"; user: AdminUser };

export function Users() {
  const all = useLoad(loadAll);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, run] = useAction();
  const close = () => setDialog(null);

  return (
    <>
      <PageHead
        title="Users"
        subtitle="Accounts for the console and for signing in on RustDesk clients."
        actions={
          <button type="button" class="btn btn-primary" onClick={() => setDialog({ kind: "create" })}>
            <Icon name="plus" />
            <span>New user</span>
          </button>
        }
      />
      <LoadView value={all}>
        {({ users, strategies, me }) => {
          const strategyName = (id: number | null) => strategies.find((s) => s.id === id)?.name;
          const rows = users.filter((u) => matches(query, u.name, u.display_name, u.email, u.note));
          const columns: Array<Column<AdminUser>> = [
            {
              label: "User",
              primary: true,
              render: (u) => (
                <div>
                  <div class="strong">
                    {u.name} {u.guid === me.guid && <span class="muted small">(you)</span>}
                  </div>
                  {u.display_name && <div class="muted small">{u.display_name}</div>}
                </div>
              ),
            },
            { label: "Email", render: (u) => u.email || <span class="muted">—</span> },
            {
              label: "Role",
              render: (u) => (u.is_admin ? <Badge tone="accent">admin</Badge> : <span class="muted">user</span>),
            },
            { label: "Status", render: (u) => <Badge tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Badge> },
            { label: "2FA", render: (u) => (u.totp_enabled ? <Badge tone="ok">on</Badge> : <span class="muted">off</span>) },
            { label: "Strategy", render: (u) => strategyName(u.strategy_id) ?? <span class="muted">—</span> },
            { label: "Created", render: (u) => <span class="small">{dateTime(u.created_at)}</span> },
          ];
          return (
            <>
              <div class="toolbar">
                <SearchBox value={query} onInput={setQuery} placeholder="Search users" />
              </div>
              {rows.length === 0 ? (
                <Empty>No user matches.</Empty>
              ) : (
                <DataTable
                  caption="Users"
                  rows={rows}
                  columns={columns}
                  rowKey={(u) => u.guid}
                  actions={(u) => {
                    const self = u.guid === me.guid;
                    return (
                      <>
                        <button type="button" class="btn btn-small" onClick={() => setDialog({ kind: "edit", user: u })}>
                          <Icon name="edit" />
                          <span>Edit</span>
                        </button>
                        {!self && (
                          <button
                            type="button"
                            class="btn btn-small"
                            disabled={busy}
                            onClick={async () => {
                              const next: UserStatus = u.status === 0 ? 1 : 0;
                              if (await run(() => Api.updateUser(u.guid, { status: next }), next === 0 ? `${u.name} disabled` : `${u.name} enabled`)) all.reload();
                            }}
                          >
                            {u.status === 0 ? "Enable" : "Disable"}
                          </button>
                        )}
                        {/* Your own password changes from My account, which keeps you signed in. */}
                        {!self && (
                          <button type="button" class="btn btn-small" onClick={() => setDialog({ kind: "password", user: u })}>
                            Password
                          </button>
                        )}
                        {u.totp_enabled && (
                          <button type="button" class="btn btn-small" onClick={() => setDialog({ kind: "totp", user: u })}>
                            Reset 2FA
                          </button>
                        )}
                        {!self && (
                          <button
                            type="button"
                            class="btn btn-small btn-danger-ghost"
                            aria-label={`Delete ${u.name}`}
                            onClick={() => setDialog({ kind: "delete", user: u })}
                          >
                            <Icon name="trash" />
                          </button>
                        )}
                      </>
                    );
                  }}
                />
              )}
              {dialog?.kind === "create" && <CreateUser onClose={close} onSaved={all.reload} />}
              {dialog?.kind === "edit" && <EditUser user={dialog.user} self={dialog.user.guid === me.guid} strategies={strategies} onClose={close} onSaved={all.reload} />}
              {dialog?.kind === "password" && <ResetPassword user={dialog.user} onClose={close} />}
              {dialog?.kind === "totp" && (
                <Confirm
                  title="Reset two-factor login"
                  message={`Turn off two-factor login for ${dialog.user.name}? They can enrol again from My account.`}
                  confirmLabel="Reset 2FA"
                  onConfirm={async () => {
                    await Api.resetTotp(dialog.user.guid);
                    all.reload();
                  }}
                  onClose={close}
                />
              )}
              {dialog?.kind === "delete" && (
                <Confirm
                  title="Delete user"
                  message={`Delete ${dialog.user.name}, their personal address book and all their sessions? This cannot be undone.`}
                  onConfirm={async () => {
                    await Api.deleteUser(dialog.user.guid);
                    all.reload();
                  }}
                  onClose={close}
                />
              )}
            </>
          );
        }}
      </LoadView>
    </>
  );
}

function CreateUser({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [admin, setAdmin] = useState(false);
  return (
    <FormModal
      title="New user"
      submitLabel="Create"
      onClose={onClose}
      onSubmit={async () => {
        if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
        await Api.createUser({ name: name.trim(), password, display_name: displayName, email, note, is_admin: admin });
        onSaved();
      }}
    >
      <TextField label="Username" value={name} onInput={setName} required autoCapitalize="none" autoComplete="off" />
      <TextField label="Password" type="password" value={password} onInput={setPassword} required minLength={MIN_PASSWORD} autoComplete="new-password" hint="At least 8 characters." />
      <TextField label="Display name" value={displayName} onInput={setDisplayName} />
      <TextField label="Email" type="email" value={email} onInput={setEmail} />
      <TextArea label="Note" value={note} onInput={setNote} rows={2} />
      <Checkbox label="Administrator" hint="May use this console." checked={admin} onChange={setAdmin} />
    </FormModal>
  );
}

function EditUser({ user, self, strategies, onClose, onSaved }: { user: AdminUser; self: boolean; strategies: Strategy[]; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(user.display_name);
  const [email, setEmail] = useState(user.email);
  const [note, setNote] = useState(user.note);
  const [admin, setAdmin] = useState(user.is_admin);
  const [status, setStatus] = useState<UserStatus>(user.status);
  const [strategy, setStrategy] = useState(user.strategy_id?.toString() ?? "");
  return (
    <FormModal
      title={`Edit ${user.name}`}
      onClose={onClose}
      onSubmit={async () => {
        await Api.updateUser(user.guid, {
          display_name: displayName,
          email,
          note,
          strategy_id: idOrNull(strategy),
          // The API refuses demoting or disabling yourself; do not send those fields for self.
          ...(self ? {} : { is_admin: admin, status }),
        });
        onSaved();
      }}
    >
      <TextField label="Display name" value={displayName} onInput={setDisplayName} />
      <TextField label="Email" type="email" value={email} onInput={setEmail} />
      <TextArea label="Note" value={note} onInput={setNote} rows={2} />
      <SelectField
        label="Strategy"
        value={strategy}
        onChange={setStrategy}
        hint="Applies to this user's devices that have no device or group strategy."
        options={[{ value: "", label: "None" }, ...strategies.map((s) => ({ value: String(s.id), label: s.name }))]}
      />
      {!self && (
        <>
          <SelectField
            label="Status"
            value={String(status)}
            onChange={(v) => setStatus(Number(v) as UserStatus)}
            options={[
              { value: "1", label: "Active" },
              { value: "0", label: "Disabled (ends all sessions)" },
              { value: "-1", label: "Unverified" },
            ]}
          />
          <Checkbox label="Administrator" checked={admin} onChange={setAdmin} />
        </>
      )}
    </FormModal>
  );
}

function ResetPassword({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  return (
    <FormModal
      title={`New password for ${user.name}`}
      submitLabel="Set password"
      onClose={onClose}
      onSubmit={async () => {
        if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
        if (password !== confirm) throw new Error("The passwords do not match");
        await Api.updateUser(user.guid, { password });
      }}
    >
      <p class="muted small">Setting a password signs {user.name} out of every device.</p>
      <TextField label="New password" type="password" value={password} onInput={setPassword} required minLength={MIN_PASSWORD} autoComplete="new-password" />
      <TextField label="Repeat password" type="password" value={confirm} onInput={setConfirm} required autoComplete="new-password" />
    </FormModal>
  );
}

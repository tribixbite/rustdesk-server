/** Shared address books: name, note, default shared password, per-user sharing rules, peers. */
import { useState } from "preact/hooks";
import { Api, type AbRule, type AdminUser, type SharedBook } from "../api";
import { Badge, Confirm, DataTable, dateTime, Empty, FormModal, Icon, LoadView, Modal, PageHead, TextArea, TextField, useLoad, type Column } from "../ui";

const RULES: Record<AbRule, string> = { 1: "Read", 2: "Read-write", 3: "Full control" };

async function loadAll() {
  const [books, users] = await Promise.all([Api.books(), Api.users()]);
  return { books, users };
}

export function Books() {
  const all = useLoad(loadAll);
  const [editing, setEditing] = useState<SharedBook | "new" | null>(null);
  const [viewing, setViewing] = useState<SharedBook | null>(null);
  const [deleting, setDeleting] = useState<SharedBook | null>(null);
  return (
    <>
      <PageHead
        title="Shared address books"
        subtitle="Address books that several users see in their RustDesk client."
        actions={
          <button type="button" class="btn btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            <span>New book</span>
          </button>
        }
      />
      <LoadView value={all}>
        {({ books, users }) => {
          const userName = (guid: string) => users.find((u) => u.guid === guid)?.name ?? guid;
          const columns: Array<Column<SharedBook>> = [
            {
              label: "Book",
              primary: true,
              render: (b) => (
                <div>
                  <div class="strong">{b.name}</div>
                  {b.note && <div class="muted small">{b.note}</div>}
                </div>
              ),
            },
            { label: "Owner", render: (b) => b.owner },
            { label: "Peers", cls: "num", render: (b) => b.peers },
            { label: "Password", render: (b) => (b.has_password ? <Badge tone="accent">set</Badge> : <span class="muted">—</span>) },
            {
              label: "Shared with",
              render: (b) =>
                b.rules.length === 0 ? (
                  <span class="muted">nobody</span>
                ) : (
                  <span class="small">{b.rules.map((r) => `${userName(r.user_guid)} (${RULES[r.rule]})`).join(", ")}</span>
                ),
            },
            { label: "Updated", render: (b) => <span class="small">{dateTime(b.updated_at)}</span> },
          ];
          return (
            <>
              {books.length === 0 ? (
                <Empty>No shared address books yet.</Empty>
              ) : (
                <DataTable
                  caption="Shared address books"
                  rows={books}
                  columns={columns}
                  rowKey={(b) => b.guid}
                  actions={(b) => (
                    <>
                      <button type="button" class="btn btn-small" onClick={() => setViewing(b)}>
                        Peers
                      </button>
                      <button type="button" class="btn btn-small" onClick={() => setEditing(b)}>
                        <Icon name="edit" />
                        <span>Edit</span>
                      </button>
                      <button type="button" class="btn btn-small btn-danger-ghost" aria-label={`Delete ${b.name}`} onClick={() => setDeleting(b)}>
                        <Icon name="trash" />
                      </button>
                    </>
                  )}
                />
              )}
              {editing && <EditBook book={editing === "new" ? null : editing} users={users} onClose={() => setEditing(null)} onSaved={all.reload} />}
              {viewing && <BookPeers book={viewing} onClose={() => setViewing(null)} />}
              {deleting && (
                <Confirm
                  title="Delete address book"
                  message={`Delete “${deleting.name}” and its ${deleting.peers} peer${deleting.peers === 1 ? "" : "s"}? This cannot be undone.`}
                  onConfirm={async () => {
                    await Api.deleteBook(deleting.guid);
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

/** Rule per user guid; 0 means not shared with that user. */
type RuleMap = Record<string, AbRule | 0>;

function EditBook({ book, users, onClose, onSaved }: { book: SharedBook | null; users: AdminUser[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(book?.name ?? "");
  const [note, setNote] = useState(book?.note ?? "");
  const [password, setPassword] = useState("");
  const [changePassword, setChangePassword] = useState(book === null);
  const [rules, setRules] = useState<RuleMap>(() => Object.fromEntries((book?.rules ?? []).map((r) => [r.user_guid, r.rule])));
  return (
    <FormModal
      title={book ? `Edit ${book.name}` : "New shared address book"}
      submitLabel={book ? "Save" : "Create"}
      onClose={onClose}
      onSubmit={async () => {
        const ruleList = Object.entries(rules)
          .filter((e): e is [string, AbRule] => e[1] !== 0)
          .map(([user_guid, rule]) => ({ user_guid, rule }));
        const body = { name: name.trim(), note, rules: ruleList, ...(changePassword ? { password } : {}) };
        if (book) await Api.updateBook(book.guid, body);
        else await Api.createBook(body);
        onSaved();
      }}
    >
      <TextField label="Name" value={name} onInput={setName} required />
      <TextArea label="Note" value={note} onInput={setNote} rows={2} />
      {changePassword ? (
        <TextField
          label="Default shared password"
          type="password"
          value={password}
          onInput={setPassword}
          autoComplete="new-password"
          hint={book ? "Empty clears the password." : "Optional. Used for peers added without a password of their own."}
        />
      ) : (
        <div class="field">
          <span class="label">Default shared password</span>
          <div class="inline">
            <span class="muted">{book?.has_password ? "Set" : "Not set"}</span>
            <button type="button" class="btn btn-small" onClick={() => setChangePassword(true)}>
              Change
            </button>
          </div>
        </div>
      )}
      <fieldset class="field">
        <legend>Sharing</legend>
        {users.length === 0 ? (
          <p class="muted small">No users.</p>
        ) : (
          <div class="rule-list">
            {users.map((u) => (
              <div key={u.guid} class="rule-row">
                <label for={`rule-${u.guid}`}>
                  {u.name}
                  {u.is_admin && <span class="muted small"> · admin</span>}
                </label>
                <select
                  id={`rule-${u.guid}`}
                  value={String(rules[u.guid] ?? 0)}
                  onChange={(e) => setRules({ ...rules, [u.guid]: Number(e.currentTarget.value) as AbRule | 0 })}
                >
                  <option value="0">No access</option>
                  <option value="1">{RULES[1]}</option>
                  <option value="2">{RULES[2]}</option>
                  <option value="3">{RULES[3]}</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </fieldset>
    </FormModal>
  );
}

function BookPeers({ book, onClose }: { book: SharedBook; onClose: () => void }) {
  const peers = useLoad(() => Api.bookPeers(book.guid), [book.guid]);
  return (
    <Modal title={`Peers in ${book.name}`} onClose={onClose} wide>
      <LoadView value={peers}>
        {(list) =>
          list.length === 0 ? (
            <Empty>No peers in this book yet. Users with write access add them from their RustDesk client.</Empty>
          ) : (
            <DataTable
              caption="Peers"
              rows={list}
              rowKey={(p) => p.id}
              columns={[
                {
                  label: "Peer",
                  primary: true,
                  render: (p) => (
                    <div>
                      <div class="strong">{p.alias || p.hostname || p.id}</div>
                      <div class="mono muted small">{p.id}</div>
                    </div>
                  ),
                },
                { label: "User", render: (p) => p.username || "—" },
                { label: "Platform", render: (p) => p.platform || "—" },
                { label: "Tags", render: (p) => (p.tags?.length ? p.tags.join(", ") : <span class="muted">—</span>) },
                { label: "Password", render: (p) => (p.has_password ? <Badge tone="accent">set</Badge> : <span class="muted">—</span>) },
                { label: "Note", render: (p) => p.note || <span class="muted">—</span> },
              ]}
            />
          )
        }
      </LoadView>
    </Modal>
  );
}

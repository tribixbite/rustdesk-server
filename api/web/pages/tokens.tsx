/** Sessions and API tokens of all users; revoke; create an API token for `rustdesk --assign`. */
import { useState } from "preact/hooks";
import { Api, type AdminToken, type TokenKind, type TokenSummary } from "../api";
import {
  Badge,
  Confirm,
  CopyButton,
  DataTable,
  dateTime,
  Empty,
  FormModal,
  Icon,
  LoadView,
  Modal,
  PageHead,
  relativeTime,
  SelectField,
  TextField,
  useLoad,
  type Column,
} from "../ui";

export const KIND_LABEL: Record<TokenKind, string> = { client: "RustDesk client", console: "Web console", api: "API token" };

/** "Windows · DESKTOP-1 · 123456789" from a session's stored device info. */
export function sessionDevice(t: TokenSummary): string {
  const info = typeof t.device_info === "object" && t.device_info !== null ? (t.device_info as Record<string, unknown>) : {};
  const parts = [info.os, info.name].filter((v): v is string => typeof v === "string" && v !== "");
  if (t.device_id) parts.push(t.device_id);
  return parts.join(" · ");
}

export function Tokens() {
  const all = useLoad(Api.tokens);
  const [kind, setKind] = useState<"" | TokenKind>("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: string; label: string } | null>(null);
  const [revoking, setRevoking] = useState<AdminToken | null>(null);
  return (
    <>
      <PageHead
        title="Sessions & API tokens"
        subtitle="Signed-in clients and consoles, plus long-lived tokens for scripted device assignment."
        actions={
          <button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            <span>New API token</span>
          </button>
        }
      />
      <LoadView value={all}>
        {(tokens) => {
          const rows = kind ? tokens.filter((t) => t.kind === kind) : tokens;
          const columns: Array<Column<AdminToken>> = [
            {
              label: "User",
              primary: true,
              render: (t) => (
                <div>
                  <div class="strong">{t.user || "—"}</div>
                  {t.label && <div class="muted small">{t.label}</div>}
                </div>
              ),
            },
            { label: "Kind", render: (t) => <Badge tone={t.kind === "api" ? "accent" : "neutral"}>{KIND_LABEL[t.kind]}</Badge> },
            { label: "Device", render: (t) => <span class="small">{sessionDevice(t) || "—"}</span> },
            { label: "Created", render: (t) => <span class="small">{dateTime(t.created_at)}</span> },
            { label: "Last used", render: (t) => <span title={dateTime(t.last_used_at)}>{relativeTime(t.last_used_at)}</span> },
            { label: "Expires", render: (t) => <span class="small">{t.expires_at ? dateTime(t.expires_at) : "never"}</span> },
          ];
          return (
            <>
              <div class="toolbar">
                <div class="toolbar-select">
                  <SelectField
                    label="Show"
                    value={kind}
                    onChange={(v) => setKind(v as "" | TokenKind)}
                    options={[
                      { value: "", label: `All (${tokens.length})` },
                      { value: "client", label: KIND_LABEL.client },
                      { value: "console", label: KIND_LABEL.console },
                      { value: "api", label: KIND_LABEL.api },
                    ]}
                  />
                </div>
              </div>
              {rows.length === 0 ? (
                <Empty>Nothing here.</Empty>
              ) : (
                <DataTable
                  caption="Sessions and tokens"
                  rows={rows}
                  columns={columns}
                  rowKey={(t) => t.token_hash}
                  actions={(t) => (
                    <button type="button" class="btn btn-small btn-danger-ghost" onClick={() => setRevoking(t)}>
                      Revoke
                    </button>
                  )}
                />
              )}
            </>
          );
        }}
      </LoadView>
      {creating && (
        <CreateToken
          onClose={() => setCreating(false)}
          onCreated={(token, label) => {
            setCreating(false);
            setCreated({ token, label });
            all.reload();
          }}
        />
      )}
      {created && <ShowToken token={created.token} label={created.label} onClose={() => setCreated(null)} />}
      {revoking && (
        <Confirm
          title="Revoke"
          message={`Revoke this ${KIND_LABEL[revoking.kind].toLowerCase()} of ${revoking.user}? ${revoking.kind === "api" ? "Scripts using it stop working." : "It is signed out."}`}
          confirmLabel="Revoke"
          onConfirm={async () => {
            await Api.revokeToken(revoking.token_hash);
            all.reload();
          }}
          onClose={() => setRevoking(null)}
        />
      )}
    </>
  );
}

function CreateToken({ onClose, onCreated }: { onClose: () => void; onCreated: (token: string, label: string) => void }) {
  const [label, setLabel] = useState("");
  return (
    <FormModal
      title="New API token"
      submitLabel="Create"
      onClose={onClose}
      onSubmit={async () => {
        const l = label.trim();
        if (!l) throw new Error("Give the token a label");
        const { token } = await Api.createToken(l);
        onCreated(token, l);
        // onCreated already closed this dialog and opened the one showing the token.
        return false;
      }}
    >
      <p class="muted small">The token acts as you (an administrator) and does not expire. Revoke it here when it is no longer needed.</p>
      <TextField label="Label" value={label} onInput={setLabel} required placeholder="e.g. deployment script" />
    </FormModal>
  );
}

function ShowToken({ token, label, onClose }: { token: string; label: string; onClose: () => void }) {
  const example = `rustdesk --assign --token ${token} --user_name <name>`;
  return (
    <Modal
      title={`API token “${label}”`}
      onClose={onClose}
      footer={
        <button type="button" class="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div class="alert alert-warn" role="note">
        Copy the token now. It is shown only once.
      </div>
      <div class="secret-box">
        <code class="break">{token}</code>
        <CopyButton text={token} />
      </div>
      <p class="muted small">Assign a device to a user from a script on that device:</p>
      <div class="secret-box">
        <code class="break">{example}</code>
        <CopyButton text={example} label="Copy command" />
      </div>
      <p class="muted small">
        Optional extra flags: <span class="mono">--strategy_name</span>, <span class="mono">--address_book_name</span>,{" "}
        <span class="mono">--device_group_name</span>.
      </p>
    </Modal>
  );
}

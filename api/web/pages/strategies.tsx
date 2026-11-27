/**
 * Strategies: named sets of client options pushed to devices on heartbeat.
 * The editor offers the server's option catalogue grouped by topic; each option
 * is either "not set" (the client keeps its own value) or a value.
 */
import { useState } from "preact/hooks";
import { Api, type Strategy, type StrategyOption, type StrategyOptions } from "../api";
import { Confirm, DataTable, dateTime, Empty, FormModal, Icon, LoadView, PageHead, TextArea, TextField, useLoad, type Column } from "../ui";

async function loadAll() {
  const [strategies, catalogue, devices, groups, users] = await Promise.all([
    Api.strategies(),
    Api.strategyOptions(),
    Api.devices(),
    Api.groups(),
    Api.users(),
  ]);
  return { strategies, catalogue, devices, groups, users };
}

export function Strategies() {
  const all = useLoad(loadAll);
  const [editing, setEditing] = useState<Strategy | "new" | null>(null);
  const [deleting, setDeleting] = useState<Strategy | null>(null);
  return (
    <>
      <PageHead
        title="Strategies"
        subtitle="Client settings pushed to devices on their next heartbeat. A device uses its own strategy, else its group's, else its owner's."
        actions={
          <button type="button" class="btn btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            <span>New strategy</span>
          </button>
        }
      />
      <LoadView value={all}>
        {({ strategies, catalogue, devices, groups, users }) => {
          const usage = (s: Strategy) => {
            const parts = [
              [devices.filter((d) => d.strategy_id === s.id).length, "device"],
              [groups.filter((g) => g.strategy_id === s.id).length, "group"],
              [users.filter((u) => u.strategy_id === s.id).length, "user"],
            ] as const;
            const text = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
            return text.length ? text.join(", ") : "unused";
          };
          const columns: Array<Column<Strategy>> = [
            {
              label: "Strategy",
              primary: true,
              render: (s) => (
                <div>
                  <div class="strong">{s.name}</div>
                  {s.note && <div class="muted small">{s.note}</div>}
                </div>
              ),
            },
            { label: "Options set", cls: "num", render: (s) => Object.keys(s.config_options).length },
            { label: "Assigned to", render: (s) => <span class="small">{usage(s)}</span> },
            { label: "Modified", render: (s) => <span class="small">{dateTime(Math.floor(s.modified_at / 1000))}</span> },
          ];
          return (
            <>
              {strategies.length === 0 ? (
                <Empty>No strategies yet. Create one to push settings such as permissions or password rules to clients.</Empty>
              ) : (
                <DataTable
                  caption="Strategies"
                  rows={strategies}
                  columns={columns}
                  rowKey={(s) => s.id}
                  actions={(s) => (
                    <>
                      <button type="button" class="btn btn-small" onClick={() => setEditing(s)}>
                        <Icon name="edit" />
                        <span>Edit</span>
                      </button>
                      <button type="button" class="btn btn-small btn-danger-ghost" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}>
                        <Icon name="trash" />
                      </button>
                    </>
                  )}
                />
              )}
              {editing && (
                <StrategyEditor strategy={editing === "new" ? null : editing} catalogue={catalogue} onClose={() => setEditing(null)} onSaved={all.reload} />
              )}
              {deleting && (
                <Confirm
                  title="Delete strategy"
                  message={`Delete “${deleting.name}” (${usage(deleting)})? Clients keep the values they already received until another strategy changes them.`}
                  onConfirm={async () => {
                    await Api.deleteStrategy(deleting.id);
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

/** Select value standing for "option not set". */
const UNSET = "\u0000unset";

function StrategyEditor({
  strategy,
  catalogue,
  onClose,
  onSaved,
}: {
  strategy: Strategy | null;
  catalogue: StrategyOptions;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(strategy?.name ?? "");
  const [note, setNote] = useState(strategy?.note ?? "");
  const [options, setOptions] = useState<Record<string, string>>({ ...(strategy?.config_options ?? {}) });
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const known = new Set(catalogue.options.map((o) => o.key));
  const rejected = new Set(catalogue.rejected);
  const groups = [...new Set(catalogue.options.map((o) => o.group))];
  const custom = Object.keys(options).filter((k) => !known.has(k));

  const setOpt = (key: string, value: string | null) => {
    const next = { ...options };
    if (value === null) delete next[key];
    else next[key] = value;
    setOptions(next);
  };

  const addCustom = () => {
    const k = newKey.trim();
    if (!k) return;
    setOpt(k, newValue);
    setNewKey("");
    setNewValue("");
  };

  return (
    <FormModal
      wide
      title={strategy ? `Edit ${strategy.name}` : "New strategy"}
      submitLabel={strategy ? "Save" : "Create"}
      onClose={onClose}
      onSubmit={async () => {
        // A half-typed custom option is saved as well, rather than silently dropped.
        const opts = newKey.trim() ? { ...options, [newKey.trim()]: newValue } : options;
        const body = { name: name.trim(), note, options: opts };
        if (strategy) await Api.updateStrategy(strategy.id, body);
        else await Api.createStrategy(body);
        onSaved();
      }}
    >
      <div class="grid-2 tight">
        <TextField label="Name" value={name} onInput={setName} required />
        <TextArea label="Note" value={note} onInput={setNote} rows={1} />
      </div>
      <p class="muted small">
        Options left at <em>Not set</em> are not sent; the client keeps its own value. {Object.keys(options).length} option
        {Object.keys(options).length === 1 ? "" : "s"} set.
      </p>
      {groups.map((g) => {
        const items = catalogue.options.filter((o) => o.group === g);
        const setCount = items.filter((o) => options[o.key] !== undefined).length;
        return (
          <details key={g} class="opt-group" open={setCount > 0 || g === groups[0]}>
            <summary>
              <span>{g}</span>
              <span class="muted small">{setCount ? `${setCount} set` : ""}</span>
            </summary>
            <div class="opt-list">
              {items.map((o) => (
                <OptionRow key={o.key} option={o} value={options[o.key]} onChange={(v) => setOpt(o.key, v)} />
              ))}
            </div>
          </details>
        );
      })}
      <details class="opt-group" open={custom.length > 0}>
        <summary>
          <span>Custom options</span>
          <span class="muted small">{custom.length ? `${custom.length} set` : ""}</span>
        </summary>
        <div class="opt-list">
          <p class="muted small">
            Any other client option by its key (see the RustDesk client's config keys). Server and connection keys are dropped when saving and never
            reach clients: <span class="mono">{catalogue.rejected.join(", ")}</span>.
          </p>
          {custom.map((k) => (
            <div key={k} class="opt-row">
              <div class="opt-label">
                <span class="mono">{k}</span>
                {rejected.has(k) && <span class="warn-text small">Not allowed: dropped when saving.</span>}
              </div>
              <div class="opt-control inline">
                <input aria-label={`Value of ${k}`} value={options[k] ?? ""} onInput={(e) => setOpt(k, e.currentTarget.value)} />
                <button type="button" class="btn btn-small btn-danger-ghost" aria-label={`Remove ${k}`} onClick={() => setOpt(k, null)}>
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
          <div class="opt-add">
            <input aria-label="New option key" placeholder="option-key" value={newKey} onInput={(e) => setNewKey(e.currentTarget.value)} autoCapitalize="none" />
            <input aria-label="New option value" placeholder="value" value={newValue} onInput={(e) => setNewValue(e.currentTarget.value)} />
            <button type="button" class="btn" onClick={addCustom} disabled={!newKey.trim()}>
              Add
            </button>
          </div>
          {newKey.trim() && rejected.has(newKey.trim()) && <p class="warn-text small">“{newKey.trim()}” is not allowed in strategies and will be dropped.</p>}
          {newKey.trim() && known.has(newKey.trim()) && <p class="warn-text small">“{newKey.trim()}” is listed above; adding it here sets the same option.</p>}
        </div>
      </details>
    </FormModal>
  );
}

/** One catalogue option: a select for bool/enum, or a "set" switch plus an input for number/text. */
function OptionRow({ option, value, onChange }: { option: StrategyOption; value: string | undefined; onChange: (v: string | null) => void }) {
  const id = `opt-${option.key}`;
  const k = option.kind;
  let control;
  if (k.type === "bool" || k.type === "enum") {
    const choices = k.type === "bool" ? [{ value: "Y", label: "Yes" }, { value: "N", label: "No" }] : k.values;
    const inList = value === undefined || choices.some((c) => c.value === value);
    control = (
      <select id={id} value={value ?? UNSET} onChange={(e) => onChange(e.currentTarget.value === UNSET ? null : e.currentTarget.value)}>
        <option value={UNSET}>Not set</option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
        {!inList && <option value={value}>{`Other: ${value}`}</option>}
      </select>
    );
  } else {
    const set = value !== undefined;
    control = (
      <div class="inline">
        <select id={set ? undefined : id} aria-label={set ? `${option.label}: set or not` : undefined} value={set ? "set" : UNSET} onChange={(e) => onChange(e.currentTarget.value === UNSET ? null : (value ?? ""))}>
          <option value={UNSET}>Not set</option>
          <option value="set">Set to</option>
        </select>
        {set && (
          <input
            id={id}
            type={k.type === "number" ? "number" : "text"}
            inputMode={k.type === "number" ? "numeric" : undefined}
            min={k.type === "number" ? k.min : undefined}
            max={k.type === "number" ? k.max : undefined}
            placeholder={k.type === "text" ? k.placeholder : undefined}
            value={value}
            onInput={(e) => onChange(e.currentTarget.value)}
          />
        )}
      </div>
    );
  }
  return (
    <div class={value === undefined ? "opt-row" : "opt-row is-set"}>
      <label class="opt-label" for={id}>
        <span>{option.label}</span>
        <span class="mono muted small">{option.key}</span>
      </label>
      <div class="opt-control">{control}</div>
    </div>
  );
}

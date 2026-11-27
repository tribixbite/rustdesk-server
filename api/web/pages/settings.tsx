/** Server settings: address-book size limit and audit retention. */
import { useEffect, useState } from "preact/hooks";
import { Api } from "../api";
import { LoadView, PageHead, TextField, useAction, useLoad } from "../ui";

export function Settings() {
  const s = useLoad(Api.settings);
  const [maxPeers, setMaxPeers] = useState("");
  const [retention, setRetention] = useState("");
  const [busy, run] = useAction();

  useEffect(() => {
    if (!s.data) return;
    setMaxPeers(String(s.data.max_peer_one_ab));
    setRetention(String(s.data.audit_retention_days));
  }, [s.data]);

  const save = async (e: Event) => {
    e.preventDefault();
    const max = Number.parseInt(maxPeers, 10);
    const days = Number.parseInt(retention, 10);
    if (!Number.isInteger(max) || max < 0 || !Number.isInteger(days) || days < 0) {
      await run(() => Promise.reject(new Error("Enter whole numbers of 0 or more")));
      return;
    }
    if (await run(() => Api.updateSettings({ max_peer_one_ab: max, audit_retention_days: days }), "Settings saved")) s.reload();
  };

  return (
    <>
      <PageHead title="Settings" subtitle="Server-wide limits." />
      <LoadView value={s}>
        {() => (
          <form class="card form narrow" onSubmit={save}>
            <TextField
              label="Max peers per address book"
              type="number"
              inputMode="numeric"
              min={0}
              value={maxPeers}
              onInput={setMaxPeers}
              hint="0 means no limit. Applies to personal and shared books."
            />
            <TextField
              label="Audit retention (days)"
              type="number"
              inputMode="numeric"
              min={0}
              value={retention}
              onInput={setRetention}
              hint="Older connection, file and alarm records are deleted. 0 keeps them forever."
            />
            <div>
              <button type="submit" class="btn btn-primary" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        )}
      </LoadView>
    </>
  );
}

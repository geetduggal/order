// Report parameters, asked at the point of invocation (the notable folder's ⋯
// menu → "Generate finance report"). Date range + which linked accounts to
// include. The report writes a snapshot CSV + HTML into `dirRel` (this folder).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import * as finance from "../lib/finance";

function monthStartIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function FinanceReportModal({ dirRel, onClose }: { dirRel: string; onClose: () => void }) {
  const [accounts, setAccounts] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [start, setStart] = useState(monthStartIso());
  const [end, setEnd] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void finance.listAccounts()
      .then((a) => { if (alive) { setAccounts(a); setSelected(a); } })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, []);

  const toggle = (a: string) =>
    setSelected((prev) => prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]);

  const generate = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const accts = selected.length ? selected : accounts;
      const r = await finance.generateReport(accts, start, end, dirRel);
      setDone(`Wrote ${r.html_path.split("/").pop()} and its CSV — $${r.data.total_spend.toFixed(2)} total spend.`);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Portal to <body> so the fixed overlay escapes the card's transformed
  // stacking context (a transformed ancestor becomes the containing block for
  // position:fixed, which otherwise trapped this modal inside the card).
  return createPortal(
    <div className="order-fin-modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="order-fin-modal" role="dialog" aria-label="Generate finance report">
        <div className="order-fin-modal-head">
          <h3>Finance report</h3>
          <button type="button" className="order-fin-modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="order-fin-modal-body">
          <label className="order-fin-field">
            <span>From</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="order-fin-field">
            <span>To</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="order-fin-field">
            <span>Accounts</span>
            {accounts.length === 0 ? (
              <em className="order-fin-empty">No linked accounts — add one in Settings → Finance.</em>
            ) : (
              <div className="order-fin-accounts">
                {accounts.map((a) => (
                  <label key={a} className="order-fin-account">
                    <input type="checkbox" checked={selected.includes(a)} onChange={() => toggle(a)} />
                    <span>{a}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {error && <div className="order-fin-error">{error}</div>}
          {done && <div className="order-fin-ok">{done}</div>}
        </div>
        <div className="order-fin-modal-foot">
          <button type="button" className="settings-btn" onClick={onClose}>{done ? "Close" : "Cancel"}</button>
          <button type="button" className="settings-btn is-primary" disabled={busy || accounts.length === 0} onClick={() => void generate()}>
            {busy ? "Working…" : "Generate"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

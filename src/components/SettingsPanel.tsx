// Settings panel — opened from the gear icon in the bottom-left.
// Currently just the vault location: shows the active path and lets
// the user pick a different folder (native dialog) or reset to the
// default. The parent persists the choice and reloads the vault.

import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X as XIcon, Folder as FolderIcon, FileText as FileTextIcon, Info as InfoIcon } from "lucide-react";
import { vaultRoot, defaultVaultRoot, getVaultOverride, isIos, isIosSync } from "../lib/vault";
import { vaultFs } from "../lib/vault-fs";
import {
  DEFAULT_TODO_TXT_PATH,
  getTodoTxtSettings,
  setTodoTxtSettings,
} from "../lib/todo-txt";

export function SettingsPanel({
  onChangeVault, onClose, onOpenTodoTxt,
}: {
  onChangeVault: (path: string | null) => Promise<void>;
  onClose: () => void;
  onOpenTodoTxt: () => Promise<void>;
}) {
  const initialTodo = getTodoTxtSettings();
  const [todoEnabled, setTodoEnabled] = useState(initialTodo.enabled);
  const [todoPath, setTodoPath] = useState(initialTodo.path);
  const persistTodo = (next: Partial<{ enabled: boolean; path: string }>) => {
    const merged = setTodoTxtSettings(next);
    setTodoEnabled(merged.enabled);
    setTodoPath(merged.path);
  };
  const [current, setCurrent] = useState<string>("");
  const [fallback, setFallback] = useState<string>("");
  const [overridden, setOverridden] = useState<boolean>(getVaultOverride() !== null);
  const [busy, setBusy] = useState(false);

  const [gcal, setGcal] = useState<import("../lib/gcal-accounts").AccountsView>({ accounts: [], default: null, has_credentials: false, client_id: "", client_id_ios: "" });
  const [gcalId, setGcalId] = useState("");
  const [gcalSecret, setGcalSecret] = useState("");
  const [gcalBusy, setGcalBusy] = useState(false);
  const [gcalError, setGcalError] = useState<string | null>(null);
  const [gcalHelpOpen, setGcalHelpOpen] = useState(false);
  const refreshGcal = useCallback(async () => {
    try { setGcal(await import("../lib/gcal-accounts").then((m) => m.listAccounts())); }
    catch (e) { setGcalError(String(e)); }
    // Notify the calendar shell so its Google-sync pending list recomputes.
    window.dispatchEvent(new Event("order:gcal-accounts-changed"));
  }, []);
  useEffect(() => { void refreshGcal(); }, [refreshGcal]);
  // Reflect the saved (non-secret) client ID back into the field so the
  // panel shows what's stored after reopening — the inputs are otherwise
  // ephemeral component state and look empty even when creds are saved.
  useEffect(() => {
    if (gcal.client_id && !gcalId) setGcalId(gcal.client_id);
  }, [gcal.client_id, gcalId]);
  const [iosId, setIosId] = useState("");
  useEffect(() => { if (gcal.client_id_ios && !iosId) setIosId(gcal.client_id_ios); }, [gcal.client_id_ios, iosId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cur, def] = await Promise.all([vaultRoot(), defaultVaultRoot()]);
      if (cancelled) return;
      setCurrent(cur);
      setFallback(def);
      setOverridden(getVaultOverride() !== null);
    })();
    return () => { cancelled = true; };
  }, []);

  const choose = async () => {
    setBusy(true);
    try {
      let picked: string | null = null;
      // iOS: Tauri's dialog plugin can't open a directory picker, so
      // the desktop `open({ directory: true })` call returns null and
      // the Change button looks broken. Route through the vault
      // plugin's iOS bridge instead — it pops a native
      // UIDocumentPickerViewController in folder-pick mode and stashes
      // a security-scoped bookmark for the chosen folder.
      if (await isIos()) {
        try {
          const v = await vaultFs.pickFolder();
          picked = v?.path ?? null;
        } catch (err) {
          console.error("iOS pick failed:", err);
        }
      } else {
        const result = await open({
          directory: true,
          multiple: false,
          defaultPath: current || undefined,
        });
        if (typeof result === "string") picked = result;
      }
      if (picked) {
        await onChangeVault(picked);
        setCurrent(picked);
        setOverridden(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await onChangeVault(null);
      setCurrent(fallback);
      setOverridden(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-label="Settings" onMouseDown={onClose}>
      <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2 className="settings-title">Settings</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close">
            <XIcon size={14} strokeWidth={2.2} />
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-label">Vault folder</span>
          <span className="settings-value" title={current}>
            <FolderIcon size={12} strokeWidth={2} />
            {current}
            {!overridden && <span className="settings-tag">default</span>}
          </span>
          <div className="settings-actions">
            <button type="button" className="settings-btn" onClick={choose} disabled={busy}>
              Change…
            </button>
            {overridden && (
              <button type="button" className="settings-btn settings-btn-quiet" onClick={reset} disabled={busy}>
                Use default
              </button>
            )}
          </div>
          <span className="settings-hint">
            Order reads and writes notes here. Pick a different folder when this
            machine's vault lives elsewhere — the choice is saved on this machine
            only.
          </span>
        </div>

        <div className="settings-row">
          <span className="settings-label">Todo.txt</span>
          <span className="settings-value">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={todoEnabled}
                onChange={(e) => persistTodo({ enabled: e.target.checked })}
              />
              <span>Use {todoPath || DEFAULT_TODO_TXT_PATH} as a calendar source</span>
            </label>
          </span>
          <span className="settings-value">
            <FileTextIcon size={12} strokeWidth={2} />
            <input
              type="text"
              className="settings-input"
              value={todoPath}
              placeholder={DEFAULT_TODO_TXT_PATH}
              onChange={(e) => setTodoPath(e.target.value)}
              onBlur={() => persistTodo({ path: todoPath })}
            />
          </span>
          <div className="settings-actions">
            <button
              type="button"
              className="settings-btn"
              onClick={() => { void onOpenTodoTxt(); }}
              disabled={!todoEnabled}
            >
              Open todo.txt
            </button>
          </div>
          <span className="settings-hint">
            Keeps <code>{todoPath || DEFAULT_TODO_TXT_PATH}</code> in sync with every
            calendar event — one line per event, readable and editable in any
            text editor. Events you create in Order are markdown files; lines
            you add by hand show up on the calendar too.
          </span>
        </div>

        <div className="settings-row">
          <span className="settings-label">
            Google Calendar
            <button
              type="button"
              className="settings-help-btn"
              onClick={() => setGcalHelpOpen((o) => !o)}
              title="How to get these credentials"
              aria-label="How to get these credentials"
            >
              <InfoIcon size={12} strokeWidth={2.2} />
            </button>
          </span>
          {gcalHelpOpen && (
            <div className="settings-help-text">
              These credentials come from <strong>your own</strong> Google Cloud project — a
              one-time, ~10-minute setup. Commercial apps hide this by shipping a Google-verified
              client; bringing your own keeps access under your control and needs no Google review.
              <ol>
                <li>Open the <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> and create a project.</li>
                <li><strong>APIs &amp; Services → Library</strong> → enable <strong>Google Calendar API</strong>.</li>
                <li><strong>OAuth consent screen / Branding</strong> → <em>External</em> → add your app name + email.</li>
                <li><strong>Audience</strong> → <strong>Test users</strong> → <strong>Add users</strong> → add the exact Google account(s) you'll connect, and Save. (Required — even in Testing mode, only listed test users can sign in; otherwise you get a <code>403 access_denied</code>.)</li>
                <li><strong>Credentials → Create Credentials → OAuth client ID</strong> → application type <strong>Desktop app</strong>.</li>
                <li>Copy the <strong>Client ID</strong> and <strong>Client secret</strong> into the fields below and Save.</li>
              </ol>
              Order stores these on this device only and uses the <code>calendar.events</code> scope.
            </div>
          )}
          {gcalError && <span className="settings-hint" style={{ color: "#d9534f" }}>{gcalError}</span>}
          {gcal.has_credentials && (
            <span className="settings-hint" style={{ color: "var(--royal)" }}>✓ Credentials saved on this device.</span>
          )}
          <span className="settings-value">
            <input type="text" className="settings-input" placeholder="OAuth Client ID"
              value={gcalId} onChange={(e) => setGcalId(e.target.value)} />
            <input type="password" className="settings-input"
              placeholder={gcal.has_credentials ? "•••••• (secret saved — re-enter to change)" : "OAuth Client Secret"}
              value={gcalSecret} onChange={(e) => setGcalSecret(e.target.value)} />
            <button type="button" className="settings-btn" disabled={gcalBusy || !gcalId || !gcalSecret}
              onClick={async () => {
                setGcalBusy(true); setGcalError(null);
                try { const m = await import("../lib/gcal-accounts"); await m.setCredentials(gcalId, gcalSecret); await refreshGcal(); }
                catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); }
              }}>Save credentials</button>
          </span>
          <span className="settings-value">
            <button type="button" className="settings-btn" disabled={gcalBusy || !gcal.has_credentials}
              onClick={async () => {
                setGcalBusy(true); setGcalError(null);
                try { const m = await import("../lib/gcal-accounts"); await m.connectAccount(); await refreshGcal(); }
                catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); }
              }}>{gcalBusy ? "Connecting…" : "Connect Google account"}</button>
          </span>
          {gcal.has_credentials && gcal.accounts.length === 0 && (
            <span className="settings-hint">No Google account connected yet — click “Connect Google account”.</span>
          )}
          <ul className="gcal-account-list">
            {gcal.accounts.map((a) => (
              <li key={a} className="gcal-account-row">
                <label className="settings-toggle">
                  <input type="radio" name="gcal-default" checked={gcal.default === a}
                    onChange={async () => { setGcalBusy(true); setGcalError(null); try { const m = await import("../lib/gcal-accounts"); await m.setDefault(a); await refreshGcal(); } catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); } }} />
                  <span>{a}{gcal.default === a ? " (default)" : ""}</span>
                </label>
                <button type="button" className="settings-btn is-danger"
                  onClick={async () => { setGcalBusy(true); setGcalError(null); try { const m = await import("../lib/gcal-accounts"); await m.disconnect(a); await refreshGcal(); } catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); } }}>Disconnect</button>
              </li>
            ))}
          </ul>
          {isIosSync() && (
            <div className="settings-subsection">
              <label className="settings-label">Google iOS Client ID</label>
              <p className="settings-hint">
                iOS uses a separate Google credential. In Google Cloud → Credentials, create an
                OAuth client of type <strong>iOS</strong> (bundle id <code>com.geetduggal.order</code>),
                and paste its Client ID here. The reversed form must also be set as the app's URL scheme
                at build time. {gcal.client_id_ios ? "✓ iOS Client ID saved on this device." : ""}
              </p>
              <input
                className="settings-input"
                placeholder="123-abc.apps.googleusercontent.com"
                value={iosId}
                onChange={(e) => setIosId(e.target.value)}
              />
              <button
                type="button"
                className="settings-btn"
                disabled={!iosId.trim()}
                onClick={async () => {
                  try { const m = await import("../lib/gcal-accounts"); await m.setIosClientId(iosId.trim()); await refreshGcal(); }
                  catch (e) { setGcalError(String(e)); }
                }}
              >Save iOS Client ID</button>
            </div>
          )}
          <span className="settings-hint">
            Connect a Google account to sync curated events. Credentials come from your own
            Google Cloud project (OAuth "Desktop app" client). The default account hosts
            events that don't name one. Desktop only for now.
          </span>
        </div>

      </div>
    </div>
  );
}

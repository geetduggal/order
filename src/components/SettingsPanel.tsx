// Settings panel — opened from the gear icon in the bottom-left.
// Currently just the vault location: shows the active path and lets
// the user pick a different folder (native dialog) or reset to the
// default. The parent persists the choice and reloads the vault.

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X as XIcon, Folder as FolderIcon } from "lucide-react";
import { vaultRoot, defaultVaultRoot, getVaultOverride, isIos } from "../lib/vault";
import { vaultFs } from "../lib/vault-fs";

export function SettingsPanel({
  onChangeVault, onClose,
}: {
  /** Persist the chosen absolute path (or null to reset to default)
   *  and reload the vault. */
  onChangeVault: (path: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState<string>("");
  const [fallback, setFallback] = useState<string>("");
  const [overridden, setOverridden] = useState<boolean>(getVaultOverride() !== null);
  const [busy, setBusy] = useState(false);

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
      </div>
    </div>
  );
}

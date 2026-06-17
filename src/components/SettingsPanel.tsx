// Settings panel — opened from the gear icon in the bottom-left.
// Currently just the vault location: shows the active path and lets
// the user pick a different folder (native dialog) or reset to the
// default. The parent persists the choice and reloads the vault.

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X as XIcon, Folder as FolderIcon, FileText as FileTextIcon } from "lucide-react";
import { vaultRoot, defaultVaultRoot, getVaultOverride, isIos } from "../lib/vault";
import { vaultFs } from "../lib/vault-fs";
import {
  DEFAULT_TODO_TXT_PATH,
  getTodoTxtSettings,
  setTodoTxtSettings,
} from "../lib/todo-txt";

export function SettingsPanel({
  onChangeVault, onClose, onOpenTodoTxt, onSyncSpacetime,
}: {
  /** Persist the chosen absolute path (or null to reset to default)
   *  and reload the vault. */
  onChangeVault: (path: string | null) => Promise<void>;
  onClose: () => void;
  /** Create the configured todo.txt file if needed and navigate to it
   *  as a card. */
  onOpenTodoTxt: () => Promise<void>;
  /** Diff the on-disk spacetime.yml against the vault and open a review
   *  of the changes it would apply (create/update/delete notes, folders). */
  onSyncSpacetime: () => void;
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
          <span className="settings-label">spacetime.yml</span>
          <div className="settings-actions">
            <button
              type="button"
              className="settings-btn"
              onClick={() => { onSyncSpacetime(); onClose(); }}
            >
              Apply spacetime.yml to vault…
            </button>
          </div>
          <span className="settings-hint">
            <code>spacetime.yml</code> at the vault root is the canonical map of
            your space and time, regenerated as you work. Edit it by hand and
            this applies your changes back to the vault — creating, updating, or
            deleting notes and folders. You review every change first, and
            anything destructive asks before it runs.
          </span>
        </div>
      </div>
    </div>
  );
}

// Publish panel — opens from the Publish pill (or Cmd+P). Lists the
// public-flagged notes that would ship with the next build, lets the
// user pick which home to publish to when multiple Notable Folders
// carry `home:`, and stubs the actual build/push (that lands in
// Phase 3).

import { useEffect, useMemo, useState } from "react";
import { X as XIcon } from "lucide-react";

export interface PublishableNote {
  filename: string;       // no .md
  title: string;          // display title
  folderRef: string | null;
  path: string;
}

export interface HomeFolder {
  /** Filename (no .md) of the home Notable Folder. */
  name: string;
  /** Display label — frontmatter.title || name. */
  title: string;
  /** `<user>/<repo>/<path>` from the `home:` YAML. */
  target: string;
}

export interface PublishOutcome {
  pushed_to: string;
  branch: string;
  commit_message: string;
  had_changes: boolean;
}

interface Props {
  homes: HomeFolder[];
  publishableNotes: PublishableNote[];
  /** Kicks off the build + push for a chosen home. Resolves with the
   *  Rust-side outcome; rejects with a string error message. */
  onPublish: (home: HomeFolder) => Promise<PublishOutcome>;
  onClose: () => void;
}

export function PublishPanel({ homes, publishableNotes, onPublish, onClose }: Props) {
  const [selectedHome, setSelectedHome] = useState<string | null>(
    homes[0]?.name ?? null,
  );
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "publishing" }
    | { kind: "ok"; outcome: PublishOutcome }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && status.kind !== "publishing") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, status.kind]);

  const current = useMemo(
    () => homes.find((h) => h.name === selectedHome) ?? null,
    [homes, selectedHome],
  );

  async function runPublish() {
    if (!current) return;
    setStatus({ kind: "publishing" });
    try {
      const outcome = await onPublish(current);
      setStatus({ kind: "ok", outcome });
    } catch (err) {
      setStatus({ kind: "error", message: typeof err === "string" ? err : (err instanceof Error ? err.message : String(err)) });
    }
  }

  return (
    <div className="publish-backdrop" onMouseDown={onClose}>
      <div
        className="publish-panel"
        role="dialog"
        aria-label="Publish"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="publish-header">
          <span className="publish-title">Publish</span>
          <button
            type="button"
            className="publish-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <XIcon size={14} strokeWidth={2} />
          </button>
        </div>

        {homes.length === 0 && (
          <div className="publish-empty">
            No Notable Folder has <code>home:</code> set in its YAML.
            Add e.g. <code>home: "user/repo/path"</code> to the folder
            you want to publish from.
          </div>
        )}

        {homes.length > 1 && (
          <div className="publish-homes">
            <span className="publish-homes-label">Home:</span>
            {homes.map((h) => (
              <button
                key={h.name}
                type="button"
                className={"publish-home" + (h.name === selectedHome ? " is-on" : "")}
                onClick={() => setSelectedHome(h.name)}
              >
                {h.title}
              </button>
            ))}
          </div>
        )}

        {current && (
          <>
            <div className="publish-target">
              <span className="publish-target-label">target</span>
              <code>{current.target}</code>
            </div>

            <div className="publish-summary">
              {publishableNotes.length}
              {" "}{publishableNotes.length === 1 ? "note is" : "notes are"} marked
              <code> public</code>.
            </div>

            {publishableNotes.length > 0 && (
              <ul className="publish-list">
                {publishableNotes.slice(0, 50).map((n) => (
                  <li key={n.path} className="publish-list-item">
                    <span className="publish-list-title">{n.title}</span>
                    {n.folderRef && (
                      <span className="publish-list-folder">{n.folderRef}</span>
                    )}
                  </li>
                ))}
                {publishableNotes.length > 50 && (
                  <li className="publish-list-more">
                    + {publishableNotes.length - 50} more…
                  </li>
                )}
              </ul>
            )}

            <div className="publish-actions">
              {status.kind === "ok" && (
                <span className="publish-status is-ok">
                  {status.outcome.had_changes
                    ? `Pushed to ${status.outcome.pushed_to} (${status.outcome.commit_message})`
                    : "Site already up to date — nothing to push."}
                </span>
              )}
              {status.kind === "error" && (
                <span className="publish-status is-err">{status.message}</span>
              )}
              <button
                type="button"
                className="publish-go"
                disabled={status.kind === "publishing"}
                onClick={() => { void runPublish(); }}
                title="Build the static bundle, write into the target repo, git push"
              >
                {status.kind === "publishing" ? "Publishing…" : "Publish"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Publish panel — opens from the Publish pill (or Cmd+P). Lists the
// public-flagged notes that would ship with the next build, lets the
// user pick which home to publish to when multiple Notable Folders
// carry `home:`, and stubs the actual build/push (that lands in
// Phase 3).

import { useEffect, useMemo, useState } from "react";
import { X as XIcon, Info } from "lucide-react";
import { isIosSync } from "../lib/vault";

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
  onPublish: (home: HomeFolder, extras: { githubToken?: string; commitMessage?: string }) => Promise<PublishOutcome>;
  onClose: () => void;
}

const TOKEN_KEY = "order.githubToken";

export function PublishPanel({ homes, publishableNotes, onPublish, onClose }: Props) {
  const ios = isIosSync();
  const [token, setToken] = useState<string>(() => {
    try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
  });
  const [commitMsg, setCommitMsg] = useState<string>("");
  const [tokenHelpOpen, setTokenHelpOpen] = useState(false);
  function persistToken(next: string) {
    setToken(next);
    try { localStorage.setItem(TOKEN_KEY, next); } catch { /* non-fatal */ }
  }
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
    if (ios && !token.trim()) {
      setStatus({ kind: "error", message: "A GitHub Personal Access Token is required for iOS publishing." });
      return;
    }
    setStatus({ kind: "publishing" });
    try {
      const outcome = await onPublish(current, {
        githubToken: token.trim() || undefined,
        commitMessage: commitMsg.trim() || undefined,
      });
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

            {ios && (
              <div className="publish-ios">
                <div className="publish-ios-row">
                  <label className="publish-ios-label" htmlFor="publish-token">
                    GitHub token
                    <button
                      type="button"
                      className="publish-ios-help"
                      onClick={() => setTokenHelpOpen((o) => !o)}
                      title="How to create a token"
                      aria-label="How to create a token"
                    >
                      <Info size={12} strokeWidth={2.2} />
                    </button>
                  </label>
                  <input
                    id="publish-token"
                    type="password"
                    className="publish-ios-input"
                    value={token}
                    placeholder="ghp_…"
                    onChange={(e) => persistToken(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                {tokenHelpOpen && (
                  <div className="publish-ios-help-text">
                    Create a fine-grained token at{" "}
                    <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">
                      github.com/settings/personal-access-tokens
                    </a>{" "}
                    with <strong>Repository · Contents · Read &amp; Write</strong>{" "}
                    permissions on{" "}
                    <code>{current.target.split("/").slice(0, 2).join("/")}</code>.
                    Paste it above — Order stores it in this device's local
                    storage so you only need to enter it once.
                  </div>
                )}
                <div className="publish-ios-row">
                  <label className="publish-ios-label" htmlFor="publish-commit">Commit message</label>
                  <input
                    id="publish-commit"
                    type="text"
                    className="publish-ios-input"
                    value={commitMsg}
                    placeholder="Publish from iOS"
                    onChange={(e) => setCommitMsg(e.target.value)}
                  />
                </div>
              </div>
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

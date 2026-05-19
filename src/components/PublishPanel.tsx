// Publish panel — opens from the Publish pill (or Cmd+P). Lists the
// public-flagged notes that would ship with the next build, lets the
// user pick which home to publish to when multiple Notable Folders
// carry `home:`, and stubs the actual build/push (that lands in
// Phase 3).

import { useEffect, useMemo, useState } from "react";
import { X as XIcon } from "lucide-react";
import type { Frontmatter } from "../lib/frontmatter";

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

interface Props {
  homes: HomeFolder[];
  publishableNotes: PublishableNote[];
  onClose: () => void;
}

export function PublishPanel({ homes, publishableNotes, onClose }: Props) {
  const [selectedHome, setSelectedHome] = useState<string | null>(
    homes[0]?.name ?? null,
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = useMemo(
    () => homes.find((h) => h.name === selectedHome) ?? null,
    [homes, selectedHome],
  );

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
              <button
                type="button"
                className="publish-go"
                disabled
                title="Phase 3 will wire the build + push"
              >
                Publish (coming in Phase 3)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

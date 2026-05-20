// Filter pill stack — sticky left rail below the fixed top buttons.
// Each active filter is a compact folder icon that expands on hover to
// reveal the folder name + a remove ×. Clicking the icon body focuses
// that folder (pins its Main Document to the top of the Stream);
// clicking × removes the pill. Shared by the app and the web viewer.

import { X as XIcon } from "lucide-react";
import { folderColor, folderIcon } from "../lib/folders";
import type { Filter } from "../lib/filters";

export function FilterPillStack({
  filters, onRemove, onJump,
}: {
  filters: Filter[];
  onRemove: (f: Filter) => void;
  onJump: (ref: string) => void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="filter-pills" role="list" aria-label="Active filters">
      {filters.map((f) => {
        const color = folderColor(f.ref);
        const Icon = folderIcon(f.ref);
        const isExclude = f.kind === "exclude";
        return (
          <div
            key={`${f.kind}:${f.ref}`}
            role="listitem"
            className={"filter-pill" + (isExclude ? " is-exclude" : "")}
            style={{ ["--pill-color" as string]: color }}
          >
            <button
              type="button"
              className="filter-pill-jump"
              onClick={() => onJump(f.ref)}
              title={isExclude ? `Excluding ${f.ref} — click to jump` : `Jump to ${f.ref}`}
            >
              <span className="filter-pill-icon">
                <Icon size={14} strokeWidth={1.8} />
              </span>
              <span className="filter-pill-name">{f.ref}</span>
            </button>
            <button
              type="button"
              className="filter-pill-x"
              onClick={() => onRemove(f)}
              title={isExclude ? "Remove exclusion" : "Remove filter"}
              aria-label={`Remove ${f.ref} filter`}
            >
              <XIcon size={11} strokeWidth={2.4} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

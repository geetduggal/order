// Inline frontmatter editor that drops in above a card's body when the
// {date} toggle in the card's top-left is opened.
//
// Goal: elegant, icon-decorated view of the YAML you'd otherwise have
// to leave the editor to inspect. Known Order fields (date, allDay /
// startTime, folder, category, public, slug, title) get dedicated icons
// + input types — the rest render as plain key: value rows so anything
// you keep in your YAML is still visible and editable.
//
// All edits flow through one onChange callback (a patch + null deletes).
// Card hands this to CardGrid's handleSetFrontmatter which does the
// read / mutate / write / sync-state dance once per change.

import { useMemo, useState } from "react";
import {
  Calendar as CalendarIcon,
  Star as StarIcon,
  Clock as ClockIcon,
  Folder as FolderIcon,
  FolderTree as FolderTreeIcon,
  Globe as GlobeIcon,
  Link as LinkIcon,
  Heading as HeadingIcon,
  Hash as HashIcon,
  Plus as PlusIcon,
  X as XIcon,
  List as ListIcon,
  ChevronsDownUp as FoldIcon,
  ExternalLink as ExternalLinkIcon,
  type LucideIcon,
} from "lucide-react";
import type { Frontmatter, toIsoDateValue as _toIsoDateValue } from "../lib/frontmatter";
import { toIsoDateValue } from "../lib/frontmatter";
import { FolderAutocomplete } from "./FolderAutocomplete";

/** True when the value reads like an http(s) URL — used to surface
 *  an "open in browser" affordance next to URL-valued frontmatter
 *  rows. Anchored so partial junk like "see https://…" doesn't
 *  qualify; the whole field has to be the URL. */
const URL_RE = /^https?:\/\/\S+$/;
function looksLikeUrl(v: unknown): v is string {
  return typeof v === "string" && URL_RE.test(v.trim());
}

/** Open a URL in the user's default browser. In the Tauri webview the
 *  `vault::open_url` command shells out to the OS opener; on the web
 *  viewer we fall back to a plain window.open with noopener. */
function openInBrowser(url: string): void {
  const trimmed = url.trim();
  // Tauri's invoke is dynamically imported so the viewer build (which
  // doesn't pull in @tauri-apps/api) tree-shakes fine.
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) {
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("open_url", { url: trimmed }).catch((err) =>
        console.warn("open_url failed:", err),
      );
    });
    return;
  }
  window.open(trimmed, "_blank", "noopener,noreferrer");
}

/** A patch is partial frontmatter; setting a key to `null` removes it. */
export type FrontmatterPatch = Record<string, unknown | null>;

interface Props {
  frontmatter: Frontmatter;
  /** Apply a patch to the frontmatter. Omitted → read-only inspector
   *  (used by the published viewer so visitors can see fields + click
   *  URL values, but not edit). */
  onChange?: (patch: FrontmatterPatch) => void | Promise<void>;
  /** Notable Folder refs surfaced as autocomplete candidates for the
   *  `folder:` field. Optional — without it the field stays a plain
   *  text input. */
  folderCandidates?: string[];
  /** Most-recent-first folder refs (e.g. visited via list-click,
   *  command palette). Shown at the top of the dropdown when the
   *  user hasn't typed anything yet. */
  recentFolders?: string[];
  /** Color lookup so each row can show a swatch matching the sidebar. */
  folderColorFor?: (ref: string) => string | undefined;
}

/** Order's special-field registry: order in the UI + icon + label. */
const KNOWN_FIELDS: { key: string; icon: LucideIcon; label: string }[] = [
  { key: "title", icon: HeadingIcon, label: "title" },
  { key: "date", icon: CalendarIcon, label: "date" },
  { key: "endDate", icon: CalendarIcon, label: "endDate" },
  { key: "allDay", icon: StarIcon, label: "all day" },
  { key: "startTime", icon: ClockIcon, label: "time" },
  { key: "endTime", icon: ClockIcon, label: "endTime" },
  { key: "endtime", icon: ClockIcon, label: "endtime" },
  { key: "folder", icon: FolderIcon, label: "folder" },
  { key: "category", icon: FolderTreeIcon, label: "category" },
  { key: "list", icon: ListIcon, label: "list" },
  { key: "folded", icon: FoldIcon, label: "folded" },
  { key: "public", icon: GlobeIcon, label: "public" },
  { key: "slug", icon: LinkIcon, label: "slug" },
  { key: "tags", icon: HashIcon, label: "tags" },
];
const KNOWN_KEYS = new Set(KNOWN_FIELDS.map((f) => f.key));
/** Fields that ALWAYS render in the inspector — even when the YAML
 *  doesn't carry them — so any note can flip them without typing.
 *  Toggling off deletes the key so the on-disk YAML stays clean for
 *  the implicit default. Booleans (public, folded) toggle to `null`
 *  on off; `list` picks "(none)" which also deletes the key. */
const ALWAYS_SHOWN = new Set(["public", "folded", "list"]);

/** Pull the bracketed name out of `[[Name]]` (Obsidian-style folder
 *  refs) so a free-text input can show / accept just the name. */
function unwrapRef(v: unknown): string {
  if (typeof v !== "string") return "";
  const m = v.trim().match(/^\[\[([^\]]+)\]\]$/);
  return (m ? m[1] : v).trim();
}

/** Render a string-ish value back as a `[[ref]]` if the prior value
 *  was wrapped, else as a plain string. */
function rewrapRef(prevRaw: unknown, next: string): string {
  if (typeof prevRaw === "string" && /^\[\[[^\]]+\]\]$/.test(prevRaw.trim())) {
    return `[[${next.trim()}]]`;
  }
  return next.trim();
}

export function FrontmatterInspector({
  frontmatter, onChange,
  folderCandidates, recentFolders, folderColorFor,
}: Props) {
  // Track the row currently being added so the picker doesn't re-open
  // every render. Stored as the chosen key (or "" for "free-form").
  const [adding, setAdding] = useState<null | { key: string; value: string }>(null);

  // Split current frontmatter into rendered-known + unknown, preserving
  // on-disk order for the unknown rest. ALWAYS_SHOWN fields render
  // regardless of presence so any card can flip public/folded without
  // typing — toggling off deletes the key so the YAML stays clean.
  const { knownPresent, unknownKeys } = useMemo(() => {
    const fm = frontmatter ?? {};
    const allKeys = Object.keys(fm);
    const known = KNOWN_FIELDS.filter((f) => f.key in fm || ALWAYS_SHOWN.has(f.key));
    const unknown = allKeys.filter((k) => !KNOWN_KEYS.has(k));
    return { knownPresent: known, unknownKeys: unknown };
  }, [frontmatter]);

  const missingKnown = KNOWN_FIELDS.filter(
    (f) => !(f.key in (frontmatter ?? {})) && !ALWAYS_SHOWN.has(f.key),
  );

  const readOnly = !onChange;
  const set = (key: string, value: unknown) => onChange?.({ [key]: value });
  const drop = (key: string) => onChange?.({ [key]: null });
  // For boolean always-shown fields, "toggle off" maps to delete so the
  // YAML stays clean — the implicit default is false everywhere we
  // care about (public, folded). Set wraps that shape.
  const toggleBool = (key: string, next: boolean) => onChange?.({ [key]: next ? true : null });

  // Read-only inspector (the published viewer): skip rows for the
  // always-shown booleans / list when they'd render as "no" with no
  // way to toggle. Visitors don't need to see implicit defaults.
  const knownToShow = readOnly
    ? knownPresent.filter((f) => f.key in (frontmatter ?? {}))
    : knownPresent;

  return (
    <div className="fm-inspector" role="group" aria-label="Frontmatter">
      <div className="fm-rows">
        {knownToShow.map(({ key, icon: Icon, label }) => {
          const isAlways = ALWAYS_SHOWN.has(key);
          const isBool = key === "public" || key === "folded" || key === "allDay";
          return (
            <KnownRow
              key={key}
              fieldKey={key}
              Icon={Icon}
              label={label}
              value={frontmatter[key]}
              onSet={isBool && isAlways ? (v) => toggleBool(key, v === true) : (v) => set(key, v)}
              onDrop={isAlways ? undefined : () => drop(key)}
              folderCandidates={folderCandidates}
              recentFolders={recentFolders}
              folderColorFor={folderColorFor}
              readOnly={readOnly}
            />
          );
        })}
        {unknownKeys.map((key) => (
          <UnknownRow
            key={key}
            fieldKey={key}
            value={frontmatter[key]}
            onSet={(v) => set(key, v)}
            readOnly={readOnly}
            onDrop={() => drop(key)}
          />
        ))}
      </div>

      {!readOnly && (
        <div className="fm-add">
          {adding ? (
            <AddRow
              initialKey={adding.key}
              initialValue={adding.value}
              missingKnown={missingKnown}
              onCommit={(k, v) => {
                if (k.trim()) onChange?.({ [k.trim()]: v });
                setAdding(null);
              }}
              onCancel={() => setAdding(null)}
            />
          ) : (
            <button
              type="button"
              className="fm-add-btn"
              onClick={() => setAdding({ key: missingKnown[0]?.key ?? "", value: "" })}
              title="Add a frontmatter field"
            >
              <PlusIcon size={11} strokeWidth={2} />
              <span>add field</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Known-field rows -------------------------------------------------

interface KnownRowProps {
  fieldKey: string;
  Icon: LucideIcon;
  label: string;
  value: unknown;
  onSet: (next: unknown) => void;
  /** Omit to disable the row's drop affordance (always-shown rows). */
  onDrop?: () => void;
  folderCandidates?: string[];
  recentFolders?: string[];
  folderColorFor?: (ref: string) => string | undefined;
  /** Read-only display (the published viewer) — render values as
   *  spans with URL clickability; no inputs, no drop button. */
  readOnly?: boolean;
}

function KnownRow({ fieldKey, Icon, label, value, onSet, onDrop, folderCandidates, recentFolders, folderColorFor, readOnly }: KnownRowProps) {
  return (
    <div className="fm-row fm-row-known" data-fm-key={fieldKey}>
      <span className="fm-row-icon" title={label}>
        <Icon size={12} strokeWidth={2} />
      </span>
      <span className="fm-row-label">{label}</span>
      <span className="fm-row-input">
        {readOnly ? (
          <ReadOnlyValue value={value} fieldKey={fieldKey} />
        ) : (
          <KnownInput
            fieldKey={fieldKey}
            value={value}
            onSet={onSet}
            folderCandidates={folderCandidates}
            recentFolders={recentFolders}
            folderColorFor={folderColorFor}
          />
        )}
      </span>
      {!readOnly && onDrop ? (
        <button
          type="button"
          className="fm-row-drop"
          onClick={onDrop}
          title={`Remove ${label}`}
          aria-label={`Remove ${label}`}
        >
          <XIcon size={11} strokeWidth={2} />
        </button>
      ) : (
        // Always-shown rows + read-only mode have no remove affordance.
        <span className="fm-row-drop-spacer" aria-hidden />
      )}
    </div>
  );
}

/** Read-only renderer: bare value display + an "open in browser"
 *  affordance for URL-valued fields. Used by the published viewer
 *  so visitors can see + click frontmatter URLs without editing. */
function ReadOnlyValue({ value, fieldKey }: { value: unknown; fieldKey: string }) {
  if (looksLikeUrl(value)) {
    const url = (value as string).trim();
    return (
      <span className="fm-readonly-url">
        <span className="fm-readonly-text" title={url}>{url}</span>
        <button
          type="button"
          className="fm-url-open"
          onClick={() => openInBrowser(url)}
          title={`Open ${url} in browser`}
          aria-label={`Open ${fieldKey} URL in browser`}
        >
          <ExternalLinkIcon size={11} strokeWidth={2} />
        </button>
      </span>
    );
  }
  // Boolean / null / object / array / number / unhandled string —
  // a quiet textual representation suffices for the viewer.
  const text = value === true ? "yes"
    : value === false ? "no"
    : value == null ? ""
    : typeof value === "string" ? value
    : typeof value === "number" ? String(value)
    : Array.isArray(value) ? value.join(", ")
    : JSON.stringify(value);
  return <span className="fm-readonly-text" title={text}>{text}</span>;
}

/** Folder autocomplete that holds a local draft so keystrokes don't
 *  commit to disk — only an explicit Enter/click calls onSet. */
function FolderKnownInput({ value, onSet, candidates, recents, colorFor }: {
  value: unknown;
  onSet: (v: unknown) => void;
  candidates: string[];
  recents?: string[];
  colorFor?: (ref: string) => string | undefined;
}) {
  const inner = unwrapRef(value);
  const [draft, setDraft] = useState(inner);
  return (
    <FolderAutocomplete
      value={draft}
      onChange={setDraft}
      onPick={(name) => { setDraft(name); onSet(rewrapRef(value, name)); }}
      onCancel={() => setDraft(inner)}
      candidates={candidates}
      recents={recents}
      colorFor={colorFor}
    />
  );
}

function KnownInput({ fieldKey, value, onSet, folderCandidates, recentFolders, folderColorFor }: {
  fieldKey: string;
  value: unknown;
  onSet: (v: unknown) => void;
  folderCandidates?: string[];
  recentFolders?: string[];
  folderColorFor?: (ref: string) => string | undefined;
}) {
  switch (fieldKey) {
    case "date":
    case "endDate": {
      // js-yaml can hand us a Date here for unquoted YYYY-MM-DD entries.
      const iso = toIsoDateValue(value) ?? "";
      return (
        <input
          type="date"
          value={iso}
          onChange={(e) => onSet(e.target.value || null)}
        />
      );
    }
    case "startTime":
    case "endTime":
    case "endtime": {
      const v = typeof value === "string" ? value : "";
      return (
        <input
          type="time"
          value={v}
          onChange={(e) => onSet(e.target.value)}
        />
      );
    }
    case "allDay":
    case "public":
    case "folded": {
      const on = value === true;
      return (
        <button
          type="button"
          className={"fm-bool" + (on ? " is-on" : "")}
          onClick={() => onSet(!on)}
          aria-pressed={on}
          title={on ? "On — click to turn off" : "Off — click to turn on"}
        >
          {on ? "yes" : "no"}
        </button>
      );
    }
    case "list": {
      // Three-state: not present (drop key) | "cards" | "lines".
      const v = typeof value === "string" ? value : "";
      return (
        <select
          className="fm-select"
          value={v}
          onChange={(e) => onSet(e.target.value || null)}
        >
          <option value="">(none)</option>
          <option value="cards">cards</option>
          <option value="lines">lines</option>
        </select>
      );
    }
    case "folder": {
      // Wikilink-wrapped refs round-trip — keep the `[[...]]` shape if
      // the user already wrote it that way. FolderKnownInput holds a
      // local draft so keystrokes don't commit; only Enter/click does.
      if (folderCandidates && folderCandidates.length > 0) {
        return (
          <FolderKnownInput
            value={value}
            onSet={onSet}
            candidates={folderCandidates}
            recents={recentFolders}
            colorFor={folderColorFor}
          />
        );
      }
      const inner = unwrapRef(value);
      return (
        <input
          type="text"
          className="fm-text"
          value={inner}
          onChange={(e) => onSet(rewrapRef(value, e.target.value))}
        />
      );
    }
    case "category": {
      const inner = unwrapRef(value);
      return (
        <input
          type="text"
          className="fm-text"
          value={inner}
          onChange={(e) => onSet(rewrapRef(value, e.target.value))}
        />
      );
    }
    case "tags": {
      const list = Array.isArray(value)
        ? value.filter((x): x is string => typeof x === "string")
        : typeof value === "string" ? [value] : [];
      return (
        <input
          type="text"
          className="fm-text"
          value={list.join(", ")}
          onChange={(e) => {
            const next = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            onSet(next.length ? next : null);
          }}
        />
      );
    }
    case "title":
    case "slug":
    default: {
      const s = typeof value === "string" ? value : (value == null ? "" : String(value));
      return (
        <input
          type="text"
          className="fm-text"
          value={s}
          onChange={(e) => onSet(e.target.value)}
        />
      );
    }
  }
}

// ---- Unknown-field rows -----------------------------------------------

function UnknownRow({ fieldKey, value, onSet, onDrop, readOnly }: {
  fieldKey: string;
  value: unknown;
  onSet: (v: unknown) => void;
  onDrop: () => void;
  readOnly?: boolean;
}) {
  // Preserve YAML scalars round-trip for primitive types we recognize;
  // anything stringly is fine to round-trip as a string.
  const isBool = typeof value === "boolean";
  const isNumber = typeof value === "number";
  const initial = isBool ? (value ? "true" : "false")
    : isNumber ? String(value)
    : typeof value === "string" ? value
    : value == null ? ""
    : JSON.stringify(value);
  return (
    <div className="fm-row fm-row-unknown" data-fm-key={fieldKey}>
      <span className="fm-row-icon fm-row-icon-dim" aria-hidden>
        <HashIcon size={11} strokeWidth={2} />
      </span>
      <span className="fm-row-label">{fieldKey}</span>
      <span className="fm-row-input">
        {readOnly ? (
          <ReadOnlyValue value={value} fieldKey={fieldKey} />
        ) : (
          <input
            type="text"
            className="fm-text"
            value={initial}
            onChange={(e) => {
              const next = e.target.value;
              if (isBool) {
                if (next === "true") onSet(true);
                else if (next === "false") onSet(false);
                else onSet(next);
              } else if (isNumber) {
                const n = Number(next);
                onSet(Number.isFinite(n) ? n : next);
              } else {
                onSet(next);
              }
            }}
          />
        )}
      </span>
      {readOnly ? (
        <span className="fm-row-drop-spacer" aria-hidden />
      ) : (
        <button
          type="button"
          className="fm-row-drop"
          onClick={onDrop}
          title={`Remove ${fieldKey}`}
          aria-label={`Remove ${fieldKey}`}
        >
          <XIcon size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

// ---- Add-field row ----------------------------------------------------

function AddRow({ initialKey, initialValue, missingKnown, onCommit, onCancel }: {
  initialKey: string;
  initialValue: string;
  missingKnown: { key: string; label: string }[];
  onCommit: (key: string, value: unknown) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState(initialKey);
  const [value, setValue] = useState(initialValue);

  // For known-key picks, "value" doesn't really apply — we seed sensible
  // defaults so the row just appears with a usable starting value.
  const commit = () => {
    const k = key.trim();
    if (!k) return onCancel();
    let v: unknown = value;
    if (k === "allDay" || k === "public" || k === "folded") v = true;
    else if (k === "list") v = value || "cards";
    else if (k === "date" || k === "endDate") v = value || null;
    else if (k === "startTime") v = value || "09:00";
    else if (k === "endtime" || k === "endTime") v = value || "10:00";
    else if (k === "tags") v = value
      ? value.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    else v = value;
    onCommit(k, v);
  };

  return (
    <div className="fm-row fm-row-add">
      <span className="fm-row-icon" aria-hidden><PlusIcon size={11} strokeWidth={2} /></span>
      {missingKnown.length > 0 ? (
        <select
          className="fm-add-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        >
          {missingKnown.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
          <option value="">other…</option>
        </select>
      ) : null}
      {(!missingKnown.length || key === "") && (
        <input
          autoFocus
          type="text"
          className="fm-text fm-add-freekey"
          placeholder="key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      )}
      <input
        type="text"
        className="fm-text"
        placeholder="value (optional)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
      />
      <button type="button" className="fm-row-commit" onClick={commit}>add</button>
      <button type="button" className="fm-row-cancel" onClick={onCancel} aria-label="Cancel">
        <XIcon size={11} strokeWidth={2} />
      </button>
    </div>
  );
}

// `_toIsoDateValue` is imported for its type only; reference it so the
// import doesn't get tree-shaken if the codebase ever turns this into a
// type-only import elsewhere.
type _Unused = typeof _toIsoDateValue;

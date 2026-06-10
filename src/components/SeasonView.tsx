// Season scope — the full-screen Areas grid filtered by a user-defined
// date range. Each Area cell lists the Notable Folders whose all-day
// events (notable updates) fell inside the season range, sorted by
// most recent activity. Prev/next step through the parsed Season[]
// in document order; today jumps to the season containing today.
//
// The view is plain React (no FullCalendar) — Seasons aren't a fixed
// calendar range, so reusing FC would buy nothing.

import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import type { Frontmatter } from "../lib/frontmatter";
import { isoDate } from "../lib/frontmatter";
import {
  buildSeasonActivity,
  findSeasonForDate,
  seasonLabel,
  type Season,
  type SeasonActivity,
} from "../lib/seasons";
import { folderColor } from "../lib/folders";

export interface SeasonViewHandle {
  prev(): void;
  next(): void;
  today(): void;
}

interface AreaForView {
  /** Area name (filename without `.md`). */
  ref: string;
  /** Notable Folder names belonging to this Area, used by the in-memory
   *  resolver to know which `folder: [[NF]]` refs are real. */
  nfRefs: string[];
}

interface NoteForView {
  frontmatter: Frontmatter;
}

interface Props {
  seasons: Season[];
  areas: AreaForView[];
  notes: NoteForView[];
  /** Click handler for an Area header or NF row. Receives the bare ref
   *  (Area name or NF name); parent decides what "open" means. */
  onOpenRef: (ref: string) => void;
  /** Calendar scope tabs at the top — same contract the other views use. */
  currentView?: "day" | "week" | "month" | "year" | "season";
  onSelectView?: (v: "day" | "week" | "month" | "year" | "season") => void;
}

export const SeasonView = forwardRef<SeasonViewHandle, Props>(function SeasonView(
  { seasons, areas, notes, onOpenRef, currentView, onSelectView },
  navRef,
) {
  const today = isoDate();
  const [index, setIndex] = useState<number>(() => {
    if (seasons.length === 0) return -1;
    const cur = findSeasonForDate(seasons, today);
    return cur ? seasons.indexOf(cur) : seasons.length - 1;
  });

  useImperativeHandle(navRef, () => ({
    prev: () => setIndex((i) => Math.max(0, i - 1)),
    next: () => setIndex((i) => Math.min(seasons.length - 1, i + 1)),
    today: () => {
      const cur = findSeasonForDate(seasons, today);
      setIndex(cur ? seasons.indexOf(cur) : Math.max(0, seasons.length - 1));
    },
  }), [seasons, today]);

  const season = index >= 0 ? seasons[index] : null;

  // Resolver: map every NF ref back to its Area (for the activity
  // group-by) and check membership against the known-NF set. Built
  // once per `areas` change.
  const resolver = useMemo(() => {
    const areaByNf = new Map<string, string>();
    const known = new Set<string>();
    for (const a of areas) {
      for (const nf of a.nfRefs) {
        areaByNf.set(nf, a.ref);
        known.add(nf);
      }
    }
    return {
      areaOf: (nf: string) => areaByNf.get(nf) ?? "",
      isKnown: (nf: string) => known.has(nf),
    };
  }, [areas]);

  const activity = useMemo<SeasonActivity>(() => {
    if (!season) return new Map();
    return buildSeasonActivity(notes, season, resolver, today);
  }, [notes, season, resolver, today]);

  const prevDisabled = index <= 0;
  const nextDisabled = index < 0 || index >= seasons.length - 1;

  return (
    <div className="season-view">
      <div className="fc-top-controls">
        {onSelectView && currentView && (
          <div className="fc-view-switch" role="tablist" aria-label="Calendar view">
            {(["day", "week", "month", "year", "season"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={currentView === v}
                className={"fc-view-tab" + (currentView === v ? " is-on" : "")}
                onClick={() => onSelectView(v)}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>

      <header className="year-head season-head">
        <div className="year-nav">
          <button
            type="button"
            className="year-nav-btn"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={prevDisabled}
            title="Previous season"
          >
            ‹
          </button>
          <button
            type="button"
            className="year-nav-btn ghost"
            onClick={() => {
              const cur = findSeasonForDate(seasons, today);
              setIndex(cur ? seasons.indexOf(cur) : Math.max(0, seasons.length - 1));
            }}
            disabled={seasons.length === 0}
          >
            today
          </button>
          <button
            type="button"
            className="year-nav-btn"
            onClick={() => setIndex((i) => Math.min(seasons.length - 1, i + 1))}
            disabled={nextDisabled}
            title="Next season"
          >
            ›
          </button>
        </div>
        <h2 className="year-label season-label">
          {season ? seasonLabel(season) : "No seasons"}
        </h2>
      </header>

      {season ? (
        <div className="season-grid">
          {areas.map((a) => {
            const rows = activity.get(a.ref) ?? [];
            return (
              <div key={a.ref} className="season-area-cell">
                <button
                  type="button"
                  className="season-area-head"
                  onClick={() => onOpenRef(a.ref)}
                >
                  {a.ref}
                </button>
                {rows.length === 0 ? (
                  <div className="season-area-empty">No updates</div>
                ) : (
                  <ul className="season-nf-list">
                    {rows.map((r) => (
                      <li key={r.nf} className="season-nf-row">
                        <span
                          className="season-nf-dot"
                          style={{ background: folderColor(r.nf) }}
                          aria-hidden="true"
                        />
                        <button
                          type="button"
                          className="season-nf-link"
                          onClick={() => onOpenRef(r.nf)}
                        >
                          {r.nf}
                        </button>
                        <span className="season-nf-count" aria-label={`${r.count} updates`}>
                          {r.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="season-empty">
          <p>No seasons defined yet.</p>
          <p className="season-empty-hint">
            Add ISO 8601 date ranges to <code>Seasons.md</code> at the vault root.
          </p>
        </div>
      )}
    </div>
  );
});

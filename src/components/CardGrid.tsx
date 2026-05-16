// Top-level shell. Loads all seed notes once (creating files / injecting
// calendar metadata as needed), then switches between the Stream masonry
// and the Week calendar. Notes' metadata is the single source of truth
// the Week view reads; individual Cards re-read their files for body
// edits so the two views can mutate safely in parallel.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { Card } from "./Card";
import { CalendarView, type NoteMeta } from "./CalendarView";
import { YearLinearView } from "./YearLinearView";
import {
  joinFrontmatter,
  splitFrontmatter,
  suggestCalendarPatch,
  type Frontmatter,
} from "../lib/frontmatter";

const SEEDS: { filename: string; seed: string }[] = [
  {
    filename: "01-quick-log.md",
    seed:
`Cold this morning. Light came in at a low angle through the kitchen and made the cream paper of the journal almost glow.`,
  },
  {
    filename: "02-publish-thought.md",
    seed:
`What if **publish** is just a checkbox in the YAML drawer, no other ceremony?

That's the whole loop: write, check, save. Static rebuild handles the rest.`,
  },
  {
    filename: "03-on-photography.md",
    seed:
`From [On Photography](#): *"To collect photographs is to collect the world."*

Same for notes — collecting them is the cheap part. The hard part is rereading them later and finding the ones that earned their place.`,
  },
  {
    filename: "04-order-essay.md",
    seed:
`# Notes that age well

If a note still makes sense to me a year from now without context, it earned its place. Most don't, and that's fine — Log absorbs the rest.

## The constraint

The 10-box constraint isn't just a discipline — it's a *visual* promise. Empty slots are part of the design.

## What I keep

- Things I'll reread
- Ideas that fight back when I try to refine them
- Drafts in motion

The rest goes to Log, where time decides.`,
  },
  {
    filename: "05-code-snippet.md",
    seed:
`Tried this little debounce wrapper today:

\`\`\`ts
function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
\`\`\`

Clean enough. The trailing-call semantics are good for autosave but bad for search-as-you-type.`,
  },
  {
    filename: "06-slow.md",
    seed:
`Kundera: the pleasure of slowness is the inverse of forgetfulness.

> Speed forgets; slowness remembers.

I want a tool that lets me be slow without feeling guilty about it.`,
  },
  {
    filename: "07-walk.md",
    seed:
`Sat afternoon. Up the ridge, all the way to the cell tower, and back along the creek. The light through the new leaves did the thing it does in late spring — that translucent green that looks like the leaves are lit from inside.

Stopped at the bench by the bend. Made a note about the trail being washed out from the storm last week. Three blowdowns since I was here last.

Home in time to make dinner.`,
  },
  {
    filename: "08-design-doc.md",
    seed:
`# Order — design doc (excerpt)

Order is a specialized note app. **Thinking, browsing, and publishing happen in one constrained surface** — a workspace, an explorer, and a publish space sharing the same screen.

It is deliberately *not* an all-in-one: Readwise still handles your highlights, Obsidian still hosts your vault, your camera roll is still your camera roll. Order's specific job is **in-place editing and exploration within a constrained three-level hierarchy** (Areas → Categories → Notable Folders).

## What this looks like

1. Cards in a stream
2. Notable Folder sections below
3. Right sidebar for navigation
4. Same surface for reading and writing

That's the whole product.`,
  },
];

const GRID_ROW_PX = 8;

type View = "stream" | "week" | "month" | "year";

interface LoadedNote {
  path: string;
  filename: string;
  frontmatter: Frontmatter;
  /** Best-guess title for the calendar event chip: first h1 stripped of `#`,
   *  else first non-empty line truncated. */
  title: string;
}

function deriveTitle(body: string, fallback: string): string {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) return t.replace(/^#+\s*/, "");
    return t.length > 60 ? t.slice(0, 57) + "…" : t;
  }
  return fallback;
}

async function loadAndNormalizeAll(): Promise<LoadedNote[]> {
  const dir = await documentDir();
  const subdir = await join(dir, "order-cards");
  const out: LoadedNote[] = [];
  for (const { filename, seed } of SEEDS) {
    const path = await join(subdir, filename);
    let raw: string;
    try {
      raw = await invoke<string>("read_text", { path });
    } catch {
      await invoke("write_text", { path, content: seed });
      raw = seed;
    }
    let { frontmatter, body } = splitFrontmatter(raw);
    const patch = suggestCalendarPatch(frontmatter, body);
    if (patch) {
      frontmatter = { ...frontmatter, ...patch };
      const next = joinFrontmatter(frontmatter, body);
      try {
        await invoke("write_text", { path, content: next });
      } catch (err) {
        console.warn("Failed to inject calendar metadata for", path, err);
      }
    }
    out.push({
      path,
      filename,
      frontmatter,
      title: deriveTitle(body, filename.replace(/\.md$/, "")),
    });
  }
  return out;
}

export function CardGrid() {
  const [notes, setNotes] = useState<LoadedNote[] | null>(null);
  const [view, setView] = useState<View>("stream");
  const [scrollTargetPath, setScrollTargetPath] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadAndNormalizeAll()
      .then((loaded) => { if (!cancelled) setNotes(loaded); })
      .catch((err: unknown) => {
        console.error("Could not load cards:", err);
      });
    return () => { cancelled = true; };
  }, []);

  useGridLayout(gridRef, view === "stream" ? notes?.length ?? 0 : 0);

  const handleEventClick = useCallback((path: string) => {
    setView("stream");
    setScrollTargetPath(path);
  }, []);

  // After switching to Stream with a target set, scroll the matching
  // card into view and pulse a highlight on it. We wait one tick so the
  // grid + cell DOM are present and the row-span layout has settled.
  useEffect(() => {
    if (view !== "stream" || !scrollTargetPath) return;
    const target = scrollTargetPath;
    const timer = setTimeout(() => {
      const grid = gridRef.current;
      if (!grid) return;
      const cell = grid.querySelector<HTMLElement>(
        `.card-grid-cell[data-path="${CSS.escape(target)}"]`,
      );
      if (!cell) return;
      cell.scrollIntoView({ behavior: "smooth", block: "center" });
      cell.classList.add("is-target");
      setTimeout(() => cell.classList.remove("is-target"), 1400);
    }, 60);
    setScrollTargetPath(null);
    return () => clearTimeout(timer);
  }, [view, scrollTargetPath]);

  const updateNoteFrontmatter = useCallback(async (path: string, patch: Frontmatter) => {
    const raw = await invoke<string>("read_text", { path });
    const { frontmatter, body } = splitFrontmatter(raw);
    const next: Frontmatter = { ...frontmatter };
    // Patch protocol: `undefined` removes a key, anything else assigns.
    // Lets CalendarView drop startTime/endTime when an event is dragged
    // into the all-day strip.
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    await invoke("write_text", { path, content: joinFrontmatter(next, body) });
    setNotes((prev) => prev?.map((n) => (n.path === path ? { ...n, frontmatter: next } : n)) ?? null);
  }, []);

  if (notes === null) {
    return <div className="card-grid-empty">Preparing cards…</div>;
  }

  const calendarNotes: NoteMeta[] = notes.map((n) => ({
    path: n.path,
    filename: n.filename,
    title: n.title,
    frontmatter: n.frontmatter,
  }));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="view-switch" role="tablist">
          <button
            className={view === "stream" ? "on" : ""}
            onClick={() => setView("stream")}
          >
            Stream
          </button>
          <button
            className={view === "week" ? "on" : ""}
            onClick={() => setView("week")}
          >
            Week
          </button>
          <button
            className={view === "month" ? "on" : ""}
            onClick={() => setView("month")}
          >
            Month
          </button>
          <button
            className={view === "year" ? "on" : ""}
            onClick={() => setView("year")}
          >
            Year
          </button>
        </div>
      </header>

      {view === "stream" && (
        <div className="card-grid" ref={gridRef}>
          {notes.map((n) => (
            <div className="card-grid-cell" data-path={n.path} key={n.path}>
              <Card path={n.path} />
            </div>
          ))}
        </div>
      )}
      {view === "week" && (
        <CalendarView
          key="week"
          notes={calendarNotes}
          initialView="timeGridWeek"
          onMoveEvent={updateNoteFrontmatter}
          onEventClick={handleEventClick}
        />
      )}
      {view === "month" && (
        <CalendarView
          key="month"
          notes={calendarNotes}
          initialView="dayGridMonth"
          onMoveEvent={updateNoteFrontmatter}
          onEventClick={handleEventClick}
        />
      )}
      {view === "year" && (
        <YearLinearView
          key="year"
          notes={calendarNotes}
          onMoveEvent={updateNoteFrontmatter}
          onEventClick={handleEventClick}
        />
      )}
    </div>
  );
}

function useGridLayout(gridRef: React.RefObject<HTMLDivElement | null>, count: number) {
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    function relayoutCell(cell: HTMLElement) {
      const styles = getComputedStyle(grid as HTMLElement);
      const rowGap = parseFloat(styles.rowGap || styles.gap || "0");
      cell.style.gridRowEnd = "";
      const rows = Math.max(1, Math.ceil((cell.offsetHeight + rowGap) / (GRID_ROW_PX + rowGap)));
      cell.style.gridRowEnd = `span ${rows}`;
    }

    function relayoutAll() {
      const cells = grid?.querySelectorAll<HTMLElement>(":scope > .card-grid-cell");
      cells?.forEach(relayoutCell);
    }

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target instanceof HTMLElement) relayoutCell(e.target);
      }
    });
    const cells = grid.querySelectorAll<HTMLElement>(":scope > .card-grid-cell");
    cells.forEach((c) => ro.observe(c));

    relayoutAll();
    window.addEventListener("resize", relayoutAll);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", relayoutAll);
    };
  }, [count, gridRef]);
}

// Masonry-ish layout: CSS Grid with measured row-spans so each card's height
// follows its content but cards stay in source order (left-to-right,
// top-to-bottom). A ResizeObserver per card re-measures when Milkdown
// content grows or shrinks; a window resize listener handles viewport
// changes (column count + per-column width).

import { useEffect, useRef, useState } from "react";
import { documentDir, join } from "@tauri-apps/api/path";
import { Card } from "./Card";

// Hardcoded seed set — varied lengths and content types so the masonry
// algorithm gets stressed. Files land in ~/Documents/order-cards/.
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

interface ResolvedSeed { filename: string; path: string; seed: string }

async function resolveSeedPaths(): Promise<ResolvedSeed[]> {
  const dir = await documentDir();
  const subdir = await join(dir, "order-cards");
  return Promise.all(SEEDS.map(async ({ filename, seed }) => ({
    filename,
    seed,
    path: await join(subdir, filename),
  })));
}

export function CardGrid() {
  const gridRef = useRef<HTMLDivElement>(null);
  const [resolved, setResolved] = useState<ResolvedSeed[]>([]);

  useEffect(() => {
    let cancelled = false;
    resolveSeedPaths()
      .then((seeds) => { if (!cancelled) setResolved(seeds); })
      .catch((err: unknown) => {
        console.error("Could not resolve card paths:", err);
      });
    return () => { cancelled = true; };
  }, []);

  useGridLayout(gridRef, resolved.length);

  if (resolved.length === 0) {
    return <div className="card-grid-empty">Preparing cards…</div>;
  }

  return (
    <div className="card-grid" ref={gridRef}>
      {resolved.map((c) => (
        <div className="card-grid-cell" key={c.path}>
          <Card path={c.path} seed={c.seed} />
        </div>
      ))}
    </div>
  );
}

// Layout effect: measure each .card-grid-cell, set grid-row span based on
// its rendered height. Re-runs on window resize and on per-cell content
// changes via ResizeObserver. Source order is preserved by sticking with
// `grid-auto-flow: row dense` and not reordering the React children.
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

# Why Order is shaped this way

The long-form reasoning behind the design. The README keeps the one-line
versions; this is where each idea gets its paragraph.

## A twenty-year through line

The impulse behind Order is old. It first surfaced around 2004 in
[*PileTiddly*](https://geetduggal.com/PileTiddly.html) — a TiddlyWiki
experiment built on the idea that digital spaces should behave like
*piles*: recently touched things float up, ignored things sink,
structure follows attention instead of imposing on it. Two decades
later the same shape keeps returning: a digital space that feels like a
real **place**, where what you see is what you have. Order is the most
complete expression of that idea, and nearly every decision below
traces back to it.

## Plain text is a covenant

Files live on your machine as `.md` with YAML frontmatter. No
proprietary store, no cloud lock-in; sync is whatever you already use.
This is less a technical choice than a covenant with your future self —
tools die, companies pivot, subscriptions lapse, but plain text has
outlived every decade of personal computing. If Order vanished
tomorrow, the vault still opens — in Obsidian, in `grep`, in anything.

## Constraint as clarity

Johnny Decimal limits: at most 10 Areas, at most 10 Categories per
Area. The constraint is the *feature* — by promising you only ten
Areas, it forces you to ask what your ten Areas actually are. Infinite
branching is what makes systems rot: you forget where things are, you
duplicate, you abandon and start over. Fewer choices, clearer mind.

## "Notable", not "Project"

Most PKM systems organize around projects (PARA), but projects come and
go while people, long arcs, and the spaces of a life persist. A Notable
Folder can be a person, a paper, a tool, a whole section of life —
anything that *holds your attention*. The shape of your Notable Folders
becomes a record of what you've cared about, which is closer to a true
map of a life than a project list will ever be.

## The newspaper template

The Pile is dynamic on purpose — it's the work surface. But the
moment you focus on a Notable Folder, a fixed template takes over: Main
Document as a wide centerpiece, recent notes orbiting it, a hairline
divider before the next section. The motivation is liturgical. A
newspaper has weight — when you pick it up you're *arriving* somewhere,
and the sections sit in known positions every time. Two modes, each
suited to its purpose: a fluid pile for working, a still page for
reading.

## Pile-based navigation

Every navigation surface does the same thing: the targeted Notable
Folder goes on **top of the pile** (the filter-pill stack). You don't
"navigate" to something; you *put it on top*. Re-clicking a buried
folder bubbles it back up; the × on any pill drops that layer. The
pile reads as a most-recently-visited breadcrumb you can walk backward
through.

## One vault, two lives

Every note carries `public: true` or it doesn't, and that boolean is
the only thing separating a private journal entry from a published
article. No separate blog, no second system. Draft in the open marked
private; flip it public when ready. The vault stays a record of one
continuous mind, partially exposed, never split into two selves. The
published site renders with the same React components as the app —
there is no template to drift from what you authored.

## Inspirations

- **Typora** — WYSIWYG markdown that hides syntax until the cursor arrives.
- **Obsidian** — the vault model; Bases inspired `list:` folders.
- **Johnny Decimal** — the 10×10 constraint that keeps hierarchy honest.
- **Google Keep** — capture should be frictionless; cards should breathe.
- **Wikipedia** — a Main Document per topic; reading and editing share a surface.
- **todo.txt** — one line per intention has aged better than every app since.
- **Medium / NYT** — typographic restraint; hairlines, not chrome.

The combination is the point: one coherent surface taking the single
best thing from each.

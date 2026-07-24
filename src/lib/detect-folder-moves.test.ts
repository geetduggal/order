// Run: npx tsx src/lib/detect-folder-moves.test.ts  → "ALL CHECKS PASS"
import { detectFolderMoves } from "./spacetime-sync";
import type { SpaceNode } from "./spacetime";

let failed = 0;
function eq<T>(a: T, e: T, label: string) {
  if (JSON.stringify(a) === JSON.stringify(e)) console.log(`ok: ${label}`);
  else { failed++; console.error(`FAIL: ${label}\n  got ${JSON.stringify(a)}\n  exp ${JSON.stringify(e)}`); }
}

const f = (name: string): SpaceNode => ({ name, children: [] });
const cat = (name: string, kids: SpaceNode[]): SpaceNode => ({ name, children: kids });
const area = (name: string, kids: SpaceNode[]): SpaceNode => ({ name, children: kids });

// 1. Cross-category renumber → one move.
{
  const old = [area("40-49 Stewardship", [cat("41 People", [f("41.01 Readwise")]), cat("43 Spaces", [])])];
  const neu = [area("40-49 Stewardship", [cat("41 People", []), cat("43 Spaces", [f("43.01 Readwise")])])];
  const m = detectFolderMoves(old, neu);
  eq(m.length, 1, "cross-category renumber: one move");
  eq(m[0]?.oldName, "41.01 Readwise", "  oldName");
  eq(m[0]?.newName, "43.01 Readwise", "  newName");
  eq(m[0]?.newPath, ["40-49 Stewardship", "43 Spaces", "43.01 Readwise"], "  newPath");
}

// 2. Move into a brand-new category (target category absent from old).
{
  const old = [area("A", [cat("41 People", [f("41.01 Readwise")])])];
  const neu = [area("A", [cat("41 People", []), cat("43 Spaces", [f("43.01 Readwise")])])];
  eq(detectFolderMoves(old, neu).length, 1, "move into new category");
}

// 3. Same-parent renumber is NOT a move (in-place rename handles it).
{
  const old = [area("A", [cat("41 People", [f("41.01 Readwise")])])];
  const neu = [area("A", [cat("41 People", [f("41.02 Readwise")])])];
  eq(detectFolderMoves(old, neu), [], "same-parent renumber → no move");
}

// 4. Genuinely new folder (no stripped twin) → no move.
{
  const old = [area("A", [cat("41 People", [f("41.01 Readwise")])])];
  const neu = [area("A", [cat("41 People", [f("41.01 Readwise")]), cat("43 Spaces", [f("43.01 Brand New")])])];
  eq(detectFolderMoves(old, neu), [], "new folder → no move");
}

// 5. Move WITHOUT renumber (same name, different category).
{
  const old = [area("A", [cat("People", [f("Readwise")]), cat("Spaces", [])])];
  const neu = [area("A", [cat("People", []), cat("Spaces", [f("Readwise")])])];
  const m = detectFolderMoves(old, neu);
  eq(m.length, 1, "plain move (no renumber)");
  eq(m[0]?.newPath, ["A", "Spaces", "Readwise"], "  newPath");
}

// 6. Ambiguous: two folders share a stripped name → skip both (no scramble).
{
  const old = [area("A", [cat("People", [f("41.01 Readwise"), f("41.02 Readwise")]), cat("Spaces", [])])];
  const neu = [area("A", [cat("People", []), cat("Spaces", [f("43.01 Readwise"), f("43.02 Readwise")])])];
  eq(detectFolderMoves(old, neu), [], "ambiguous stripped names → no move");
}

if (failed) { console.error(`\n${failed} FAILURES`); process.exit(1); }
else console.log("\nALL CHECKS PASS");

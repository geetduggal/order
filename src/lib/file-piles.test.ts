// Run: npx tsx src/lib/file-piles.test.ts  → prints "ALL CHECKS PASS"
import { computePileOrder } from "./file-piles";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const set = (...xs: string[]) => new Set(xs);

// 1. Default: no front, no hidden → dated order unchanged.
assertEq(
  computePileOrder(["b.md", "c.md"], [], set()),
  ["b.md", "c.md"],
  "default dated order",
);

// 2. Front prepends and reorders to the top, in front-array order.
assertEq(
  computePileOrder(["b.md", "c.md"], ["x.md", "c.md"], set()),
  ["x.md", "c.md", "b.md"],
  "front items first, then remaining dated",
);

// 3. Hidden removes from the stream (whether dated or front).
assertEq(
  computePileOrder(["b.md", "c.md"], ["x.md"], set("b.md")),
  ["x.md", "c.md"],
  "hidden dropped",
);

// 4. Dedup: a path in both front and dated appears once, in its front slot.
assertEq(
  computePileOrder(["b.md", "c.md"], ["c.md"], set()),
  ["c.md", "b.md"],
  "dedup front vs dated",
);

// 5. mainDocPath is defensively excluded and never appears.
assertEq(
  computePileOrder(["b.md"], ["main.md"], set(), "main.md"),
  ["b.md"],
  "main doc never in stream",
);

// 6. A hidden front item is dropped (close wins over add).
assertEq(
  computePileOrder(["b.md"], ["x.md"], set("x.md")),
  ["b.md"],
  "hidden beats front",
);

console.log("ALL CHECKS PASS");

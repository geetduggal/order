// Run: npx tsx src/lib/first-header.test.ts  → "ALL CHECKS PASS"
import { firstMajorHeader } from "./frontmatter";

let failed = 0;
function eq<T>(a: T, e: T, label: string) {
  if (JSON.stringify(a) === JSON.stringify(e)) console.log(`ok: ${label}`);
  else { failed++; console.error(`FAIL: ${label}\n  got ${JSON.stringify(a)}\n  exp ${JSON.stringify(e)}`); }
}

// firstMajorHeader: first ATX h1 only.
eq(firstMajorHeader("# Living Room Refresh\n\nbody"), "Living Room Refresh", "first h1");
eq(firstMajorHeader("---\nx: 1\n---\n# Hello World\ntext"), "Hello World", "h1 after (already-split) body");
eq(firstMajorHeader("intro line\n# Later Header"), "Later Header", "h1 not on first line");
eq(firstMajorHeader("## Not major\n# Major"), "Major", "skips h2, takes h1");
eq(firstMajorHeader("no header here\njust text"), null, "no h1 → null");
eq(firstMajorHeader("# Title with **bold** and `code`"), "Title with bold and code", "inline markdown stripped");
eq(firstMajorHeader("#NoSpace"), null, "not a header without space");
eq(firstMajorHeader(undefined), null, "undefined body → null");

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
else console.log("\nALL CHECKS PASS");

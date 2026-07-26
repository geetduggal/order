// Run: npx tsx src/lib/badge.test.ts  → "ALL CHECKS PASS"
import { upcomingSaturdayIso } from "./badge";
let failed = 0;
const eq = (a: string, e: string, label: string) => { if (a === e) console.log(`ok: ${label}`); else { failed++; console.error(`FAIL: ${label}\n  got ${a}\n  exp ${e}`); } };
// 2026-07-25 is a Saturday → returns itself (current Saturday).
eq(upcomingSaturdayIso(new Date(2026, 6, 25)), "2026-07-25", "Saturday → itself");
// Sunday 2026-07-26 → next Saturday 2026-08-01.
eq(upcomingSaturdayIso(new Date(2026, 6, 26)), "2026-08-01", "Sunday → next Saturday");
// Wednesday 2026-07-29 → 2026-08-01.
eq(upcomingSaturdayIso(new Date(2026, 6, 29)), "2026-08-01", "Wednesday → upcoming Saturday");
// Friday 2026-07-31 → 2026-08-01.
eq(upcomingSaturdayIso(new Date(2026, 6, 31)), "2026-08-01", "Friday → next day Saturday");
if (failed) { console.error(`\n${failed} FAILURES`); process.exit(1); } else console.log("\nALL CHECKS PASS");

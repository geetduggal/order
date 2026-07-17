// Run: npx tsx src/lib/note-view.test.ts  → "ALL CHECKS PASS"
import {
  parseView, sheetSidecarPath, drawingSidecarPath,
  serializeSheet, parseSheet, emptySheet, padSheet, resolveSheetBg,
  type SheetCell,
} from "./note-view";

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) console.log(`ok: ${label}`);
  else { failed++; console.error(`FAIL: ${label}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- view parsing ----
check(parseView({}) === "note", "no view → note");
check(parseView({ view: "sheet" }) === "sheet", "view: sheet");
check(parseView({ view: "drawing" }) === "drawing", "view: drawing");
check(parseView({ view: "bogus" }) === "note", "unknown view → note");

// ---- sidecar paths ----
check(sheetSidecarPath("A/B/My Note.md") === "A/B/My Note.sheet.html", "sheet sidecar");
check(drawingSidecarPath("A/B/My Note.md") === "A/B/My Note.excalidraw", "drawing sidecar");
check(sheetSidecarPath("/v/Deep/File.MD") === "/v/Deep/File.sheet.html", "sidecar case-insensitive .md");

// ---- background resolution ----
check(resolveSheetBg(undefined) === undefined, "no bg → undefined");
check(resolveSheetBg("t:rose") === "var(--sheet-rose)", "palette token → css var");
check(resolveSheetBg("#ffcc00") === "#ffcc00", "custom hex passthrough");

// ---- sheet serialize / parse round-trip ----
const data: SheetCell[][] = [
  [{ value: "Name" }, { value: "Qty", bg: "t:blue" }],
  [{ value: "Widgets" }, { value: "=1+2", collapse: true }],
  [{ value: "", }, { value: "", bg: "#ffcc00" }],
];
const html = serializeSheet(data);
check(html.includes('data-bg="t:blue"'), "serialize keeps palette bg");
check(html.includes('data-collapse="1"'), "serialize keeps collapse");
check(html.includes("=1+2"), "serialize keeps formula text");
const round = parseSheet(html);
check(round[0][0].value === "Name", "round-trip value");
check(round[0][1].bg === "t:blue", "round-trip palette bg");
check(round[1][1].collapse === true, "round-trip collapse");
check(round[1][1].value === "=1+2", "round-trip formula");
check(round[2][1].bg === "#ffcc00", "round-trip custom hex bg");

// HTML-escaping safety
const risky: SheetCell[][] = [[{ value: '<b>&"x"' }]];
const rt = parseSheet(serializeSheet(risky));
check(rt[0][0].value === '<b>&"x"', "escapes + unescapes special chars");

// ---- empty / pad ----
check(emptySheet(3, 4).length === 3 && emptySheet(3, 4)[0].length === 4, "emptySheet dims");
const padded = padSheet([[{ value: "x" }]], 5, 6);
check(padded.length === 5 && padded[0].length === 6 && padded[0][0].value === "x", "pad grows, keeps content");
check(eq(padSheet(emptySheet(10, 10), 3, 3).length, 10), "pad never shrinks");

if (failed > 0) { console.error(`\n${failed} CHECK(S) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASS");

// Unit tests for applySpaceMutation — pure tree mutations, no I/O.
import { applySpaceMutation, type SpaceNode } from "../../src/lib/spacetime";
import assert from "node:assert";

const base: SpaceNode[] = [
  {
    name: "Work", children: [
      {
        name: "Projects", children: [
          { name: "Order", children: [] },
          { name: "PKM", children: [] },
        ],
      },
      { name: "Teams", children: [{ name: "Frontend", children: [] }] },
    ],
  },
];

// addArea
let r = applySpaceMutation(base, { kind: "addArea", name: "Personal" });
assert.equal(r.length, 2, "addArea: length");
assert.equal(r[1].name, "Personal", "addArea: name");

// addArea duplicate is no-op
r = applySpaceMutation(base, { kind: "addArea", name: "Work" });
assert.equal(r.length, 1, "addArea: duplicate is no-op");

// removeArea
r = applySpaceMutation(base, { kind: "removeArea", name: "Work" });
assert.equal(r.length, 0, "removeArea");

// reorderAreas
r = applySpaceMutation(
  [...base, { name: "Personal", children: [] }],
  { kind: "reorderAreas", names: ["Personal", "Work"] },
);
assert.equal(r[0].name, "Personal", "reorderAreas");
assert.equal(r[1].name, "Work", "reorderAreas order");

// addCategory
r = applySpaceMutation(base, { kind: "addCategory", area: "Work", name: "Ops" });
assert.equal(r[0].children.length, 3, "addCategory: length");
assert.equal(r[0].children[2].name, "Ops", "addCategory: name");

// addCategory duplicate
r = applySpaceMutation(base, { kind: "addCategory", area: "Work", name: "Projects" });
assert.equal(r[0].children.length, 2, "addCategory: duplicate no-op");

// removeCategory
r = applySpaceMutation(base, { kind: "removeCategory", area: "Work", name: "Teams" });
assert.equal(r[0].children.length, 1, "removeCategory");
assert.equal(r[0].children[0].name, "Projects", "removeCategory: remaining");

// reorderCategories
r = applySpaceMutation(base, { kind: "reorderCategories", area: "Work", names: ["Teams", "Projects"] });
assert.equal(r[0].children[0].name, "Teams", "reorderCategories");
assert.equal(r[0].children[1].name, "Projects", "reorderCategories");

// addFolder
r = applySpaceMutation(base, { kind: "addFolder", area: "Work", category: "Projects", name: "NewApp" });
const proj = r[0].children[0];
assert.equal(proj.children.length, 3, "addFolder: length");
assert.equal(proj.children[2].name, "NewApp", "addFolder: name");

// addFolder duplicate
r = applySpaceMutation(base, { kind: "addFolder", area: "Work", category: "Projects", name: "Order" });
assert.equal(r[0].children[0].children.length, 2, "addFolder: duplicate no-op");

// removeFolder
r = applySpaceMutation(base, { kind: "removeFolder", area: "Work", category: "Projects", name: "Order" });
assert.equal(r[0].children[0].children.length, 1, "removeFolder: length");
assert.equal(r[0].children[0].children[0].name, "PKM", "removeFolder: remaining");

// reorderFolders
r = applySpaceMutation(base, { kind: "reorderFolders", area: "Work", category: "Projects", names: ["PKM", "Order"] });
assert.equal(r[0].children[0].children[0].name, "PKM", "reorderFolders");
assert.equal(r[0].children[0].children[1].name, "Order", "reorderFolders");

console.log("ALL PASS — spacetime-mutations");

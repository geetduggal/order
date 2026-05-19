// Read-only viewer entry. Fetches data.json at boot, mounts ViewerApp
// which reuses Order's Sidebar / ListView / CommandPalette in
// read-only mode plus a thin markdown surface for note bodies.

import React from "react";
import ReactDOM from "react-dom/client";
import { ViewerApp } from "./ViewerApp";
import "../src/styles.css";
import "./viewer.css";
import type { PublishedSite } from "../src/lib/publish";

async function boot() {
  const root = document.getElementById("viewer-root");
  if (!root) return;

  let data: PublishedSite;
  try {
    const res = await fetch("./data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    root.innerHTML = `<div class="viewer-error">
      <h1>data.json not found</h1>
      <p>The published bundle needs <code>data.json</code> alongside <code>index.html</code>.
      Publish from Order to produce it. (${String(err)})</p>
    </div>`;
    return;
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ViewerApp data={data} />
    </React.StrictMode>,
  );
}

void boot();

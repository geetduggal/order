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

  // Prerendered permalink pages inject window.__ORDER__ with the page's
  // slug and the root-absolute data.json URL (a relative ./data.json
  // would break from a page one level deep). Fall back to ./data.json
  // for a bundle served at the root with no prerender.
  const order = (window as unknown as {
    __ORDER__?: { slug?: string; dataUrl?: string };
  }).__ORDER__;
  const dataUrl = order?.dataUrl || "./data.json";

  let data: PublishedSite;
  try {
    const res = await fetch(dataUrl, { cache: "no-cache" });
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

  // Base path the site is served under (e.g. "/order-home/"), derived
  // from the data URL, so filter state can be encoded in the URL.
  const basePath = dataUrl.replace(/data\.json$/, "");

  // createRoot (not hydrateRoot) replaces any prerendered static content
  // in #viewer-root — the takeover.
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ViewerApp data={data} initialSlug={order?.slug || null} basePath={basePath} />
    </React.StrictMode>,
  );
}

void boot();

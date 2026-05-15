import { open } from "@tauri-apps/plugin-dialog";

export function VaultPicker({ onPick }: { onPick: (path: string) => void }) {
  async function pick() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") onPick(selected);
  }
  return (
    <div className="picker">
      <div className="picker-card">
        <div className="mark">Order<span className="dot" /></div>
        <div className="tag">Your notes, at home at last.</div>
        <button className="picker-btn" onClick={pick}>Choose your vault directory</button>
        <div className="hint">
          Markdown files on your machine. Sync via Obsidian, iCloud, or Git — your choice.
        </div>
      </div>
    </div>
  );
}

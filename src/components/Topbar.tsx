type Props = {
  view: "stream" | "calendar";
  setView: (v: "stream" | "calendar") => void;
  dirty: number;
  onPublish: () => void;
  vaultPath: string;
  onChangeVault: () => void;
};

export function Topbar({ view, setView, dirty, onPublish, vaultPath, onChangeVault }: Props) {
  const vaultName = vaultPath.split("/").filter(Boolean).pop() || vaultPath;
  return (
    <header className="topbar">
      <button className="crumb crumb-btn" onClick={onChangeVault} title={vaultPath}>
        {vaultName} <span className="crumb-change">↻</span>
      </button>
      <div className="spacer" />
      <nav className="view-switch">
        <button className={view === "stream" ? "on" : ""} onClick={() => setView("stream")}>Stream</button>
        <button className={view === "calendar" ? "on" : ""} onClick={() => setView("calendar")}>Calendar</button>
      </nav>
      <button
        className={"publish-pill" + (dirty > 0 ? " dirty" : "")}
        onClick={() => dirty > 0 && onPublish()}
      >
        <span className="dot" />
        <span>{dirty > 0 ? `Publish ${dirty}` : "Publish"}</span>
      </button>
    </header>
  );
}

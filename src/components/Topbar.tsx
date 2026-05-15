type Props = {
  view: "stream" | "calendar";
  setView: (v: "stream" | "calendar") => void;
  dirty: number;
  onPublish: () => void;
};

export function Topbar({ view, setView, dirty, onPublish }: Props) {
  return (
    <header className="topbar">
      <div className="crumb">All notes</div>
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

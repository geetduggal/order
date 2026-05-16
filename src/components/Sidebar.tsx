// Right sidebar — currently only the View pill at the top. Areas /
// Categories / Notable Folders sections will come back once their
// filter wiring is real; right now they'd just be decorative.

export type View = "stream" | "week" | "month" | "year";

const VIEWS: { id: View; label: string }[] = [
  { id: "stream", label: "Stream" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

interface Props {
  view: View;
  onSelectView: (v: View) => void;
}

export function Sidebar({ view, onSelectView }: Props) {
  return (
    <aside className="pane-right">
      <section className="sb-section">
        <h2 className="sb-title">View</h2>
        <div className="view-switch">
          {VIEWS.map((v) => (
            <button
              type="button"
              key={v.id}
              className={view === v.id ? "active" : ""}
              onClick={() => onSelectView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

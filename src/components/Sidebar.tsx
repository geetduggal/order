// Right sidebar — currently hosts the View switcher (Stream / Week /
// Month / Year). Toggle visibility from a subtle corner icon; when
// closed the panel collapses to zero width and the toggle is the only
// chrome on the screen.

interface Props {
  view: "stream" | "week" | "month" | "year";
  onSelectView: (view: "stream" | "week" | "month" | "year") => void;
}

const VIEWS: { id: Props["view"]; label: string }[] = [
  { id: "stream", label: "Stream" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

export function Sidebar({ view, onSelectView }: Props) {
  return (
    <aside className="pane-right">
      <section className="sb-section">
        <h2 className="sb-title">View</h2>
        <ul className="sb-list">
          {VIEWS.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                className={"sb-item" + (view === v.id ? " active" : "")}
                onClick={() => onSelectView(v.id)}
              >
                {v.label}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

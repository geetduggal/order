// Scroll-anchor tabs. Display only; the actual selection lives in the right sidebar.

import { useEffect, useState } from "react";

type Props = { folders: string[]; onClear: () => void };

export function FolderTabs({ folders, onClear }: Props) {
  const [active, setActive] = useState<string>("all");

  // Simple scrollspy: detect which section is in view.
  useEffect(() => {
    const targets = [
      ...document.querySelectorAll<HTMLElement>(".recent-wrap, .notable-section"),
    ];
    if (!targets.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (!visible.length) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const target = visible[0].target as HTMLElement;
        const f = target.classList.contains("recent-wrap")
          ? "all"
          : (target.dataset.folder || "all");
        setActive(f);
      },
      { rootMargin: "-25% 0px -65% 0px" }
    );
    targets.forEach((t) => obs.observe(t));
    return () => obs.disconnect();
  }, [folders.join(",")]);

  function jump(folder: string) {
    const target =
      folder === "all"
        ? document.querySelector(".recent-wrap")
        : document.querySelector(`.notable-section[data-folder="${CSS.escape(folder)}"]`)
            || document.querySelector(".recent-wrap");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav className="folder-tabs">
      <button className={"ff" + (active === "all" ? " in-view" : "")} onClick={() => jump("all")}>All</button>
      {folders.map((f) => (
        <button
          key={f}
          className={"ff" + (active === f ? " in-view" : "")}
          data-folder={f}
          onClick={() => jump(f)}
        >
          <span className="dot" />{f}
        </button>
      ))}
      {folders.length > 0 && (
        <button className="clear" onClick={onClear}>Clear</button>
      )}
    </nav>
  );
}

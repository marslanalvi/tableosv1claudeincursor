import { useEffect, useMemo, useState } from "react";
import account from "../account/account.module.css";
import { HELP_TOPICS, HelpNavContext } from "./help-content.tsx";
import s from "./help.module.css";

export function HelpPage({ topic, onTopic, onBack }: { topic: string; onTopic: (t: string) => void; onBack: () => void }) {
  const [q, setQ] = useState("");
  const current = HELP_TOPICS.find((t) => t.id === topic) ?? HELP_TOPICS[0]!;
  const index = HELP_TOPICS.indexOf(current);
  const prev = HELP_TOPICS[index - 1];
  const next = HELP_TOPICS[index + 1];

  const visible = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return HELP_TOPICS;
    return HELP_TOPICS.filter((t) => {
      const hay = `${t.title} ${t.summary} ${t.keywords} ${t.group}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [q]);
  const groups = useMemo(() => [...new Set(visible.map((t) => t.group))], [visible]);

  useEffect(() => {
    document.title = `${current.title} · TableOS Help`;
    window.scrollTo(0, 0);
  }, [current]);

  return (
    <HelpNavContext.Provider value={onTopic}>
      <div className={account.page}>
        <header className={account.header}>
          <button type="button" className={account.back} onClick={onBack}>
            ← Back
          </button>
          <h1 className={account.title}>Help &amp; documentation</h1>
        </header>
        <div className={s.layout}>
          <nav className={s.nav} aria-label="Help topics">
            <input
              className={s.search}
              type="search"
              placeholder="Search help…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search help"
            />
            {groups.map((g) => (
              <div key={g}>
                <div className={s.group}>{g}</div>
                {visible
                  .filter((t) => t.group === g)
                  .map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={t.id === current.id ? s.navItemOn : s.navItem}
                      aria-current={t.id === current.id ? "page" : undefined}
                      onClick={() => onTopic(t.id)}
                    >
                      {t.title}
                    </button>
                  ))}
              </div>
            ))}
            {!visible.length ? <div className={s.empty}>No topics match “{q}”.</div> : null}
          </nav>
          <article className={s.article}>
            <h1>{current.title}</h1>
            <p className={s.lead}>{current.summary}</p>
            {current.body()}
            <div className={s.footer}>
              {prev ? (
                <button type="button" className={s.link} onClick={() => onTopic(prev.id)}>
                  ← {prev.title}
                </button>
              ) : (
                <span />
              )}
              {next ? (
                <button type="button" className={s.link} onClick={() => onTopic(next.id)}>
                  {next.title} →
                </button>
              ) : null}
            </div>
          </article>
        </div>
      </div>
    </HelpNavContext.Provider>
  );
}

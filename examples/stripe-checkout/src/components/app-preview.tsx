import { FileText, Hash, Plus, Search, Sparkles } from "lucide-react";

const NOTEBOOKS = [
  { name: "Inbox", count: 12, active: false },
  { name: "Engineering", count: 31, active: true },
  { name: "Product", count: 8, active: false },
  { name: "Design", count: 17, active: false },
  { name: "Reading", count: 5, active: false },
];

const PAGES = [
  { title: "Postgres → vector index", date: "Today", active: true },
  { title: "Q3 platform plan", date: "Today" },
  { title: "Hiring loop redesign", date: "Yesterday" },
  { title: "Migrating to TS strict", date: "Yesterday" },
  { title: "Onboarding teardown", date: "Mon" },
];

export function AppPreview() {
  return (
    <div className="relative">
      <div className="absolute -inset-x-8 -top-12 -bottom-12 -z-10 bg-[radial-gradient(ellipse_at_top,oklch(0.92_0_0)_0%,transparent_60%)]" />
      <div className="mx-auto w-full max-w-5xl overflow-hidden rounded-2xl bg-card shadow-2xl ring-1 ring-foreground/10">
        <div className="flex items-center gap-2 border-b border-foreground/8 bg-muted/40 px-4 py-2.5">
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
          </div>
          <div className="ml-2 text-[11px] font-medium text-muted-foreground">acme-studio</div>
          <div className="ml-auto flex items-center gap-1 rounded-md bg-background px-2 py-1 text-[11px] text-muted-foreground ring-1 ring-foreground/10">
            <Search className="size-3" />
            <span>Search or jump to…</span>
            <kbd className="ml-3 rounded bg-muted px-1 text-[10px]">⌘K</kbd>
          </div>
        </div>

        <div className="grid grid-cols-[180px_240px_1fr] divide-x divide-foreground/8 text-[12px]">
          <aside className="bg-muted/20 p-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Notebooks
              </span>
              <Plus className="size-3 text-muted-foreground" />
            </div>
            <ul className="mt-2 space-y-0.5">
              {NOTEBOOKS.map((nb) => (
                <li
                  key={nb.name}
                  className={
                    nb.active
                      ? "flex items-center justify-between rounded-md bg-foreground/5 px-2 py-1 text-foreground"
                      : "flex items-center justify-between rounded-md px-2 py-1 text-foreground/70"
                  }
                >
                  <span className="flex items-center gap-1.5">
                    <Hash className="size-3 text-muted-foreground" />
                    {nb.name}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{nb.count}</span>
                </li>
              ))}
            </ul>

            <div className="mt-5 flex items-center gap-1.5 rounded-md bg-foreground/[0.04] px-2 py-1.5 text-[11px] text-foreground/70">
              <Sparkles className="size-3 text-foreground/60" />
              Ask Acme
            </div>
          </aside>

          <div className="p-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Engineering
              </span>
              <FileText className="size-3 text-muted-foreground" />
            </div>
            <ul className="mt-2 space-y-1">
              {PAGES.map((p) => (
                <li
                  key={p.title}
                  className={
                    p.active
                      ? "rounded-md bg-foreground px-2 py-1.5 text-background"
                      : "rounded-md px-2 py-1.5 text-foreground/80 hover:bg-foreground/5"
                  }
                >
                  <p className="truncate font-medium">{p.title}</p>
                  <p className={p.active ? "text-background/70" : "text-muted-foreground"}>{p.date}</p>
                </li>
              ))}
            </ul>
          </div>

          <article className="overflow-hidden bg-background p-6 leading-relaxed">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Engineering · Today
            </p>
            <h3 className="mt-1 text-base font-semibold tracking-tight">Postgres → vector index</h3>

            <div className="mt-4 space-y-3 text-foreground/85">
              <p>
                We have <span className="rounded bg-muted px-1 font-mono text-[11px]">~14M</span> docs in the support
                corpus and answer-quality is plateauing on lexical retrieval alone. Plan: keep Postgres as the source of
                truth, project embeddings into a separate index, fan out at query time.
              </p>

              <div className="rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-5 ring-1 ring-foreground/5">
                <span className="text-muted-foreground">-- per-row trigger</span>
                <br />
                <span>create function </span>
                <span className="text-foreground">embed_after_insert</span>
                <span>() returns trigger as $$</span>
                <br />
                <span className="ml-4">begin</span>
                <br />
                <span className="ml-8">perform pg_notify(</span>
                <span className="text-foreground">'embeddings'</span>
                <span>, new.id::text);</span>
                <br />
                <span className="ml-8">return new;</span>
                <br />
                <span className="ml-4">end;</span>
                <br />
                <span>$$ language plpgsql;</span>
              </div>

              <ul className="ml-5 list-disc space-y-1">
                <li>Backfill nightly, online for new rows.</li>
                <li>Hybrid scoring: <span className="font-mono text-[11px]">0.6 · vec + 0.4 · bm25</span>.</li>
                <li>Re-rank top 50 with the small reranker.</li>
              </ul>
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Webhook } from "lucide-react";

interface Entry {
  id: number;
  event: string;
  receivedAt: string;
  sessionId?: string;
}

function relative(iso: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(iso).getTime());
  if (elapsed < 1500) return "just now";
  if (elapsed < 60_000) return `${Math.round(elapsed / 1000)}s ago`;
  return `${Math.round(elapsed / 60_000)}m ago`;
}

export function WebhookOverlay() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const sinceRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await fetch(`/api/webhook-log?since=${sinceRef.current}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { entries: Entry[] };
        if (cancelled) return;
        if (data.entries.length > 0) {
          sinceRef.current = data.entries[data.entries.length - 1].id;
          setEntries((prev) => [...data.entries.slice().reverse(), ...prev].slice(0, 5));
        }
      } catch {
        // ignore network errors during transient dev reloads
      } finally {
        if (!cancelled) {
          timeout = setTimeout(poll, 750);
        }
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 w-80">
      <div className="rounded-xl bg-card/90 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur">
        <div className="flex items-center gap-2 border-b border-foreground/5 pb-2">
          <Webhook className="size-4 text-foreground/70" />
          <span className="text-xs font-medium uppercase tracking-wide text-foreground/70">Webhook activity</span>
        </div>
        <div className="mt-2 space-y-1.5 font-mono text-[11px]">
          {entries.length === 0 ? (
            <p className="text-muted-foreground">Listening…</p>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-foreground">{entry.event}</div>
                  {entry.sessionId ? (
                    <div className="truncate text-muted-foreground">{entry.sessionId}</div>
                  ) : null}
                </div>
                <span className="shrink-0 text-muted-foreground">{relative(entry.receivedAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

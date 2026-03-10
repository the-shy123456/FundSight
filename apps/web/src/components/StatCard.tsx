import type { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string;
  note: string;
  accent?: string;
  icon?: ReactNode;
}

export function StatCard({ title, value, note, accent = "from-white to-slate-50", icon }: StatCardProps) {
  return (
    <article className={`rounded-2xl border border-slate-200 bg-gradient-to-br ${accent} p-5 shadow-sm`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">{title}</p>
          <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900">{value}</p>
        </div>
        {icon ? <div className="rounded-2xl border border-white/80 bg-white/80 p-3 text-slate-700 shadow-sm">{icon}</div> : null}
      </div>
      <p className="mt-3 text-sm text-slate-500">{note}</p>
    </article>
  );
}

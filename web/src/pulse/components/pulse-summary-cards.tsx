import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  FileCode2Icon,
  LaptopIcon,
} from "lucide-react";

import type { DailyPulseResponse } from "@/api/schemas";

export function PulseSummaryCards({ pulse }: { pulse: DailyPulseResponse }) {
  const { summary } = pulse;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
      <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-xs flex flex-col justify-between">
        <div className="flex items-center justify-between text-muted-foreground mb-2">
          <span className="text-xs font-medium uppercase tracking-wider">Active Agents</span>
          <BotIcon className="size-4 text-blue-500" />
        </div>
        <div>
          <div className="text-2xl font-bold">{summary.active_agents_count}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Contributing today</p>
        </div>
      </div>

      <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-xs flex flex-col justify-between">
        <div className="flex items-center justify-between text-muted-foreground mb-2">
          <span className="text-xs font-medium uppercase tracking-wider">Active Devices</span>
          <LaptopIcon className="size-4 text-violet-500" />
        </div>
        <div>
          <div className="text-2xl font-bold">{summary.total_sessions_count}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Connected machines</p>
        </div>
      </div>

      <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-xs flex flex-col justify-between">
        <div className="flex items-center justify-between text-muted-foreground mb-2">
          <span className="text-xs font-medium uppercase tracking-wider">Files Modified</span>
          <FileCode2Icon className="size-4 text-emerald-500" />
        </div>
        <div>
          <div className="text-2xl font-bold">{summary.unique_files_touched_count}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Touched across codebase</p>
        </div>
      </div>

      <div className={`p-4 rounded-xl border bg-card text-card-foreground shadow-xs flex flex-col justify-between ${
        summary.active_blockers_count > 0 ? "border-red-500/40 bg-red-500/5" : ""
      }`}>
        <div className="flex items-center justify-between text-muted-foreground mb-2">
          <span className="text-xs font-medium uppercase tracking-wider">Blockers</span>
          {summary.active_blockers_count > 0 ? (
            <AlertTriangleIcon className="size-4 text-red-500 animate-pulse" />
          ) : (
            <CheckCircle2Icon className="size-4 text-emerald-500" />
          )}
        </div>
        <div>
          <div className={`text-2xl font-bold ${summary.active_blockers_count > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
            {summary.active_blockers_count}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {summary.active_blockers_count > 0 ? "Needs team attention" : "All streams clear"}
          </p>
        </div>
      </div>
    </div>
  );
}

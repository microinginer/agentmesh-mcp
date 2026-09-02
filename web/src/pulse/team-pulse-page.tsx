import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FlameIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import {
  dailyPulseResponseSchema,
  projectResponseSchema,
  pulseBlockerResolutionResponseSchema,
  type DailyPulseResponse,
  type Project,
} from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectShell } from "@/projects/project-shell";

import { BlockerRadar } from "./components/blocker-radar";
import { DeveloperCard } from "./components/developer-card";
import { PulseSummaryCards } from "./components/pulse-summary-cards";
import { StandupExportDialog } from "./components/standup-export-dialog";

function formatDateDisplay(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) return dateStr;
  const date = new Date(Date.UTC(year, month - 1, day));

  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) {
    return "Today, " + date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }

  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function shiftDate(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) return dateStr;
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function TeamPulsePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { api } = useSession();

  const todayStr = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [pulse, setPulse] = useState<DailyPulseResponse | null>(null);
  const [project, setProject] = useState<Project>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPulse = useCallback(async (date: string) => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.query(
        `/api/v1/projects/${projectId}/pulse?date=${date}`,
        dailyPulseResponseSchema,
      );
      setPulse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team pulse");
    } finally {
      setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    void fetchPulse(selectedDate);
  }, [fetchPulse, selectedDate]);

  useEffect(() => {
    let current = true;
    setProject(undefined);
    if (!projectId) return () => { current = false; };
    void api.query(`/api/v1/projects/${projectId}`, projectResponseSchema)
      .then((response) => { if (current) setProject(response.project); })
      .catch(() => { /* Pulse remains usable if only project metadata is unavailable. */ });
    return () => { current = false; };
  }, [api, projectId]);

  const handlePrevDay = () => setSelectedDate((curr) => shiftDate(curr, -1));
  const handleNextDay = () => setSelectedDate((curr) => shiftDate(curr, 1));
  const handleToday = () => setSelectedDate(todayStr);
  const handleResolveBlocker = async (reportId: string, note: string) => {
    if (!projectId) return;
    await api.mutate(
      `/api/v1/projects/${projectId}/pulse/blockers/${reportId}/resolve`,
      { method: "POST", body: { note } },
      pulseBlockerResolutionResponseSchema,
    );
    await fetchPulse(selectedDate);
  };

  return (
    <ProjectShell
      {...(projectId === undefined ? {} : { projectId })}
      {...(project === undefined ? {} : { projectName: project.name, canEdit: project.can_edit })}
    >
      <div className="team-pulse-page space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <FlameIcon className="size-6 text-amber-500" />
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Team Pulse</h1>
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
              Daily proof-of-work, goals, progress milestones, and blocker radar across team agents.
            </p>
          </div>

          {/* Actions & Standup export */}
          <div className="flex items-center gap-2 flex-wrap">
            {pulse && <StandupExportDialog pulse={pulse} />}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchPulse(selectedDate)}
              disabled={loading}
              className="gap-1.5"
            >
              <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>

        {/* Date Navigator Bar */}
        <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg border bg-muted/20">
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon" onClick={handlePrevDay} className="size-8" title="Previous day">
              <ChevronLeftIcon className="size-4" />
            </Button>
            <div className="flex items-center gap-2 font-medium text-xs sm:text-sm px-2">
              <CalendarIcon className="size-4 text-muted-foreground" />
              <span>{formatDateDisplay(selectedDate)}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleNextDay}
              className="size-8"
              title="Next day"
              disabled={selectedDate >= todayStr}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>

          {selectedDate !== todayStr && (
            <Button variant="outline" size="sm" onClick={handleToday} className="text-xs h-7">
              Jump to Today
            </Button>
          )}
        </div>

        {/* Content Area */}
        {loading && !pulse ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
            <Skeleton className="h-48 w-full" />
          </div>
        ) : error ? (
          <div className="p-6 rounded-xl border border-red-500/20 bg-red-500/5 text-center space-y-2">
            <p className="text-sm font-semibold text-red-600 dark:text-red-400">Failed to load pulse</p>
            <p className="text-xs text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void fetchPulse(selectedDate)}>Retry</Button>
          </div>
        ) : pulse ? (
          <div className="space-y-6">
            {/* Blocker Radar Banner (if any) */}
            <BlockerRadar
              pulse={pulse}
              canEdit={project?.can_edit === true}
              onResolve={handleResolveBlocker}
            />

            {/* Metrics Overview */}
            <PulseSummaryCards pulse={pulse} />

            {/* Developers Activity Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="min-w-0 text-base font-semibold flex items-center gap-2">
                  <UsersIcon className="size-4 text-muted-foreground" />
                  <span className="break-anywhere">Team Members & Sessions ({pulse.developers.length})</span>
                </h2>
              </div>

              {pulse.developers.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FlameIcon className="size-5 text-amber-500" />
                    </EmptyMedia>
                    <EmptyTitle>No team activity on this day</EmptyTitle>
                    <EmptyDescription>
                      No agents or developers logged sessions or progress reports on this date.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="grid gap-4">
                  {pulse.developers.map((dev) => (
                    <DeveloperCard key={dev.user_id ?? dev.display_name} developer={dev} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </ProjectShell>
  );
}

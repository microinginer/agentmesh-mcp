import { and, asc, eq, gte, lte } from "drizzle-orm";

import type { ActivityService } from "../activity/service.js";
import type { OperationContext } from "../activity/types.js";
import type { AgentService } from "../agents/service.js";
import type { ReportProgressInput } from "../contracts.js";
import type { AgentMeshDatabase } from "../db/client.js";
import {
  agentProgressReports,
  agents,
  projectTokens,
  users,
  type AgentProgressReport,
  type AgentProgressState,
  type TestStatusReport,
} from "../db/schema.js";

export interface PublicProgressReport {
  id: string;
  agent_id: string;
  summary: string;
  current_goal: string | null;
  files_touched: string[];
  test_status: TestStatusReport | null;
  state: AgentProgressState;
  blocker_reason: string | null;
  created_at: string;
}

export interface PulseAgentSummary {
  agent_id: string;
  name: string;
  client: string;
  status: "online" | "idle" | "offline";
  last_seen_at: string;
  current_goal: string | null;
  latest_progress: {
    summary: string;
    state: AgentProgressState;
    blocker_reason: string | null;
    test_status: TestStatusReport | null;
    files_touched: string[];
    reported_at: string;
  } | null;
  history: Array<{
    id: string;
    time: string;
    summary: string;
    state: AgentProgressState;
    blocker_reason: string | null;
  }>;
}

export interface PulseConnectionSummary {
  connection_id: string | null;
  label: string;
  agents: PulseAgentSummary[];
}

export interface PulseDeveloperSummary {
  user_id: string | null;
  display_name: string;
  avatar_url: string | null;
  connections: PulseConnectionSummary[];
}

export interface DailyPulseResponse {
  ok: true;
  date: string;
  summary: {
    active_agents_count: number;
    total_sessions_count: number;
    active_blockers_count: number;
    unique_files_touched_count: number;
    unique_files_touched: string[];
  };
  developers: PulseDeveloperSummary[];
}

interface PulseServiceDependencies {
  db: AgentMeshDatabase;
  agentService: Pick<AgentService, "authenticateAgent">;
  activity: Pick<ActivityService, "record" | "recordBestEffort">;
  clock?: () => Date;
}

function publicProgressReport(report: AgentProgressReport): PublicProgressReport {
  return {
    id: report.id,
    agent_id: report.agentId,
    summary: report.summary,
    current_goal: report.currentGoal,
    files_touched: report.filesTouched,
    test_status: report.testStatus ?? null,
    state: report.state as AgentProgressState,
    blocker_reason: report.blockerReason,
    created_at: report.createdAt.toISOString(),
  };
}

function deriveAgentPresence(lastSeenAt: Date, now: Date): "online" | "idle" | "offline" {
  const elapsed = now.getTime() - lastSeenAt.getTime();
  if (elapsed <= 5 * 60 * 1_000) {
    return "online";
  }
  if (elapsed <= 30 * 60 * 1_000) {
    return "idle";
  }
  return "offline";
}

export function createPulseService(dependencies: PulseServiceDependencies) {
  const { db, agentService, activity } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  async function recordProgress(
    projectId: string,
    input: ReportProgressInput,
    context: OperationContext,
  ): Promise<{ report: PublicProgressReport }> {
    const now = clock();

    return await db.transaction(async (transaction) => {
      const agent = await agentService.authenticateAgent(
        projectId,
        input.agent_token,
        transaction,
      );

      // Update agent lastSeenAt
      await transaction
        .update(agents)
        .set({ lastSeenAt: now })
        .where(and(eq(agents.projectId, projectId), eq(agents.id, agent.id)));

      const payload: typeof agentProgressReports.$inferInsert = {
        projectId,
        agentId: agent.id,
        summary: input.summary,
        currentGoal: input.current_goal ?? null,
        filesTouched: input.files_touched,
        testStatus: input.test_status ?? null,
        state: input.state,
        blockerReason: input.state === "blocked" ? (input.blocker_reason ?? "Unspecified blocker") : null,
        createdAt: now,
      };

      const [inserted] = await transaction
        .insert(agentProgressReports)
        .values(payload)
        .returning();

      if (inserted === undefined) {
        throw new Error("Failed to insert progress report");
      }

      await activity.record({
        projectId,
        requestId: context.requestId,
        eventType: "agent.progress_reported",
        outcome: "success",
        actorAgentId: agent.id,
      }, transaction);

      return { report: publicProgressReport(inserted) };
    });
  }

  async function getDailyPulse(
    projectId: string,
    targetDateStr?: string,
  ): Promise<DailyPulseResponse> {
    const now = clock();
    const dateStr = targetDateStr ?? now.toISOString().slice(0, 10);

    // Parse start and end of target day (UTC)
    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);

    // 1. Fetch all progress reports on this day for the project
    const reports = await db
      .select()
      .from(agentProgressReports)
      .where(
        and(
          eq(agentProgressReports.projectId, projectId),
          gte(agentProgressReports.createdAt, startOfDay),
          lte(agentProgressReports.createdAt, endOfDay),
        ),
      )
      .orderBy(asc(agentProgressReports.createdAt));

    // 2. Fetch all agents for this project
    const projectAgents = await db
      .select({
        agent: agents,
        token: projectTokens,
        user: users,
      })
      .from(agents)
      .leftJoin(
        projectTokens,
        and(
          eq(projectTokens.id, agents.registeredViaTokenId),
          eq(projectTokens.projectId, agents.projectId),
        ),
      )
      .leftJoin(users, eq(users.id, projectTokens.createdByUserId))
      .where(eq(agents.projectId, projectId));

    const agentReportsMap = new Map<string, AgentProgressReport[]>();
    const allTouchedFiles = new Set<string>();

    for (const report of reports) {
      const list = agentReportsMap.get(report.agentId) ?? [];
      list.push(report);
      agentReportsMap.set(report.agentId, list);
      for (const file of report.filesTouched) {
        allTouchedFiles.add(file);
      }
    }

    // Filter agents that either had activity today or were created/seen today
    const activeTodayAgents = projectAgents.filter(({ agent }) => {
      const hasReportsToday = agentReportsMap.has(agent.id);
      const wasSeenToday = agent.lastSeenAt >= startOfDay && agent.lastSeenAt <= endOfDay;
      return hasReportsToday || wasSeenToday;
    });

    let activeBlockersCount = 0;
    const developerMap = new Map<string, PulseDeveloperSummary>();

    for (const { agent, token, user } of activeTodayAgents) {
      const agentReports = agentReportsMap.get(agent.id) ?? [];
      const latestReport = agentReports.length > 0 ? agentReports[agentReports.length - 1] : null;

      if (latestReport?.state === "blocked") {
        activeBlockersCount++;
      }

      const agentSummary: PulseAgentSummary = {
        agent_id: agent.id,
        name: agent.name,
        client: agent.client,
        status: deriveAgentPresence(agent.lastSeenAt, now),
        last_seen_at: agent.lastSeenAt.toISOString(),
        current_goal: latestReport?.currentGoal ?? null,
        latest_progress: latestReport
          ? {
              summary: latestReport.summary,
              state: latestReport.state as AgentProgressState,
              blocker_reason: latestReport.blockerReason,
              test_status: latestReport.testStatus ?? null,
              files_touched: latestReport.filesTouched,
              reported_at: latestReport.createdAt.toISOString(),
            }
          : null,
        history: agentReports.map((r) => ({
          id: r.id,
          time: r.createdAt.toISOString().slice(11, 16),
          summary: r.summary,
          state: r.state as AgentProgressState,
          blocker_reason: r.blockerReason,
        })),
      };

      const userIdKey = user?.id ?? "unassigned";
      let developer = developerMap.get(userIdKey);
      if (!developer) {
        developer = {
          user_id: user?.id ?? null,
          display_name: user?.displayName ?? (token?.label ? `Device: ${token.label}` : "CLI Agent"),
          avatar_url: user?.avatarUrl ?? null,
          connections: [],
        };
        developerMap.set(userIdKey, developer);
      }

      let connection = developer.connections.find((c) => c.connection_id === (token?.id ?? null));
      if (!connection) {
        connection = {
          connection_id: token?.id ?? null,
          label: token?.label ?? "Direct CLI",
          agents: [],
        };
        developer.connections.push(connection);
      }

      connection.agents.push(agentSummary);
    }

    const uniqueFiles = Array.from(allTouchedFiles).toSorted();
    const developersList = Array.from(developerMap.values());

    const totalSessions = developersList.reduce(
      (sum, dev) => sum + dev.connections.length,
      0,
    );

    return {
      ok: true,
      date: dateStr,
      summary: {
        active_agents_count: activeTodayAgents.length,
        total_sessions_count: totalSessions,
        active_blockers_count: activeBlockersCount,
        unique_files_touched_count: uniqueFiles.length,
        unique_files_touched: uniqueFiles,
      },
      developers: developersList,
    };
  }

  return {
    recordProgress,
    getDailyPulse,
  };
}

export type PulseService = ReturnType<typeof createPulseService>;

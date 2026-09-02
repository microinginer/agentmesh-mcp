CREATE TABLE "agent_progress_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"current_goal" text,
	"files_touched" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"test_status" jsonb,
	"state" varchar(24) DEFAULT 'in_progress' NOT NULL,
	"blocker_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_progress_reports_state_check" CHECK ("agent_progress_reports"."state" IN ('in_progress', 'blocked', 'completed', 'idle'))
);
--> statement-breakpoint
ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_type_check";--> statement-breakpoint
ALTER TABLE "agent_progress_reports" ADD CONSTRAINT "agent_progress_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_progress_reports" ADD CONSTRAINT "agent_progress_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "progress_project_created_idx" ON "agent_progress_reports" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "progress_agent_created_idx" ON "agent_progress_reports" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_type_check" CHECK ("activity_events"."event_type" IN ('agent.registered', 'agent.registration_failed', 'agent.synced', 'agent.progress_reported', 'message.sent', 'message.send_failed', 'message.acknowledged', 'blackboard.fact_set', 'blackboard.fact_deleted', 'mcp.request_failed'));--> statement-breakpoint
CREATE VIEW "observer"."progress_reports" AS (select "id", "project_id", "agent_id", "summary", "current_goal", "files_touched", "test_status", "state", "blocker_reason", "created_at" from "agent_progress_reports");
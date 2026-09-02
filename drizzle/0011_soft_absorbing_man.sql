ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_type_check";--> statement-breakpoint
ALTER TABLE "agent_progress_reports" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_progress_reports" ADD COLUMN "resolved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_progress_reports" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "agent_progress_reports" ADD CONSTRAINT "agent_progress_reports_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_type_check" CHECK ("audit_events"."event_type" IN (
        'auth.login_succeeded', 'auth.login_failed', 'auth.logout',
        'project.created', 'project.archived', 'project.restored', 'project.deleted',
        'connection.created', 'connection.revoked',
        'pulse.blocker_resolved',
        'operator.user_blocked', 'operator.user_unblocked', 'operator.project_archived',
        'operator.project_owner_assigned'
      ));
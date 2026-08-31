ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_type_check";--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_type_check" CHECK ("audit_events"."event_type" IN (
        'auth.login_succeeded', 'auth.login_failed', 'auth.logout',
        'project.created', 'project.archived', 'project.restored', 'project.deleted',
        'connection.created', 'connection.revoked',
        'operator.user_blocked', 'operator.user_unblocked', 'operator.project_archived',
        'operator.project_owner_assigned'
      ));
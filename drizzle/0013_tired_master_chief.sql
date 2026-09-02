ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_type_check";--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_type_check" CHECK ("audit_events"."event_type" IN (
        'auth.login_succeeded', 'auth.login_failed', 'auth.logout',
        'project.created', 'project.archived', 'project.restored', 'project.deleted',
        'project.invitation_created', 'project.invitation_revoked', 'project.invitation_redeemed',
        'project.viewer_removed',
        'connection.created', 'connection.revoked',
        'pulse.blocker_resolved',
        'operator.user_blocked', 'operator.user_unblocked', 'operator.project_archived',
        'operator.project_owner_assigned'
      ));
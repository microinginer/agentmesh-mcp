export const auditEventTypes = [
  "auth.login_succeeded", "auth.login_failed", "auth.logout",
  "project.created", "project.archived", "project.restored", "project.deleted",
  "project.invitation_created", "project.invitation_revoked", "project.invitation_redeemed",
  "project.viewer_removed",
  "connection.created", "connection.revoked",
  "pulse.blocker_resolved",
  "operator.user_blocked", "operator.user_unblocked", "operator.project_archived",
  "operator.project_owner_assigned",
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

export type AuditActor =
  | { kind: "user"; userId: string }
  | { kind: "headless_cli" };

export interface AuditMetadata {
  provider?: "github";
  oauth_failure_stage?:
    | "callback_cookie"
    | "callback_query"
    | "current_session"
    | "exchange"
    | "profile"
    | "identity"
    | "session";
  oauth_failure_reason?: "query_syntax" | "query_keys" | "code_format" | "state_format";
  connection_label?: string;
  project_name?: string;
  invitation_id?: string;
  actor_kind?: "user" | "headless_cli";
  actor_user_id?: string;
  subject_user_id?: string;
  request_id?: string;
}

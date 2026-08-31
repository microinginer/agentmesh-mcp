export const auditEventTypes = [
  "auth.login_succeeded", "auth.login_failed", "auth.logout",
  "project.created", "project.archived", "project.restored", "project.deleted",
  "connection.created", "connection.revoked",
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
  connection_label?: string;
  project_name?: string;
  actor_kind?: "user" | "headless_cli";
  actor_user_id?: string;
  subject_user_id?: string;
  request_id?: string;
}

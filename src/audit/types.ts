export const auditEventTypes = [
  "auth.login_succeeded", "auth.login_failed", "auth.logout",
  "project.created", "project.archived", "project.restored", "project.deleted",
  "connection.created", "connection.revoked",
  "operator.user_blocked", "operator.user_unblocked", "operator.project_archived",
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

export interface AuditMetadata {
  provider?: "github";
  connection_label?: string;
  project_name?: string;
}

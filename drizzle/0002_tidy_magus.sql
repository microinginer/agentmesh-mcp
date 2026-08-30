CREATE SCHEMA "observer";
--> statement-breakpoint
CREATE VIEW "observer"."activity_events" AS (select "sequence", "id", "project_id", "request_id", "event_type", "outcome", "actor_agent_id", "target_agent_id", "message_id", "error_code", "metadata", "created_at" from "public"."activity_events");--> statement-breakpoint
CREATE VIEW "observer"."agents" AS (select "id", "project_id", "name", "client", "capabilities", "last_seen_at", "created_at" from "public"."agents");--> statement-breakpoint
CREATE VIEW "observer"."messages" AS (select "sequence", "id", "project_id", "sender_agent_id", "recipient_agent_id", "text", "created_at", "acknowledged_at" from "public"."messages");--> statement-breakpoint
CREATE VIEW "observer"."projects" AS (select "id", "name", "created_at" from "public"."projects");--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SCHEMA "observer" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "observer" FROM PUBLIC;

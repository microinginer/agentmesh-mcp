CREATE TABLE "blackboard_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"namespace" varchar(64) NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"ttl_seconds" integer,
	"expires_at" timestamp with time zone,
	"created_by_type" varchar(16) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"last_updated_by_type" varchar(16) NOT NULL,
	"last_updated_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blackboard_entries_project_namespace_key_unique" UNIQUE("project_id","namespace","key"),
	CONSTRAINT "blackboard_entries_version_positive_check" CHECK ("blackboard_entries"."version" > 0),
	CONSTRAINT "blackboard_entries_ttl_positive_check" CHECK ("blackboard_entries"."ttl_seconds" IS NULL OR "blackboard_entries"."ttl_seconds" > 0),
	CONSTRAINT "blackboard_entries_created_by_type_check" CHECK ("blackboard_entries"."created_by_type" IN ('agent', 'user')),
	CONSTRAINT "blackboard_entries_last_updated_by_type_check" CHECK ("blackboard_entries"."last_updated_by_type" IN ('agent', 'user'))
);
--> statement-breakpoint
ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_type_check";--> statement-breakpoint
ALTER TABLE "blackboard_entries" ADD CONSTRAINT "blackboard_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blackboard_entries_project_namespace_idx" ON "blackboard_entries" USING btree ("project_id","namespace");--> statement-breakpoint
CREATE INDEX "blackboard_entries_project_expires_at_idx" ON "blackboard_entries" USING btree ("project_id","expires_at");--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_type_check" CHECK ("activity_events"."event_type" IN ('agent.registered', 'agent.registration_failed', 'agent.synced', 'message.sent', 'message.send_failed', 'message.acknowledged', 'blackboard.fact_set', 'blackboard.fact_deleted', 'mcp.request_failed'));
ALTER TABLE "messages" ADD CONSTRAINT "messages_id_project_unique" UNIQUE("id","project_id");--> statement-breakpoint
CREATE TABLE "activity_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"actor_agent_id" uuid,
	"target_agent_id" uuid,
	"message_id" uuid,
	"error_code" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_events_id_unique" UNIQUE("id"),
	CONSTRAINT "activity_events_type_check" CHECK ("activity_events"."event_type" IN ('agent.registered', 'agent.registration_failed', 'agent.synced', 'message.sent', 'message.send_failed', 'message.acknowledged', 'mcp.request_failed')),
	CONSTRAINT "activity_events_outcome_check" CHECK ("activity_events"."outcome" IN ('success', 'failure'))
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_project_fk" FOREIGN KEY ("actor_agent_id","project_id") REFERENCES "public"."agents"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_target_project_fk" FOREIGN KEY ("target_agent_id","project_id") REFERENCES "public"."agents"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_message_project_fk" FOREIGN KEY ("message_id","project_id") REFERENCES "public"."messages"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_project_sequence_idx" ON "activity_events" USING btree ("project_id","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_project_type_sequence_idx" ON "activity_events" USING btree ("project_id","event_type","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_project_actor_sequence_idx" ON "activity_events" USING btree ("project_id","actor_agent_id","sequence" DESC NULLS LAST);

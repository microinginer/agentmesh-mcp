CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"event_type" varchar(64) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_type_check" CHECK ("audit_events"."event_type" IN (
        'auth.login_succeeded', 'auth.login_failed', 'auth.logout',
        'project.created', 'project.archived', 'project.restored', 'project.deleted',
        'connection.created', 'connection.revoked',
        'operator.user_blocked', 'operator.user_unblocked', 'operator.project_archived'
      ))
);
--> statement-breakpoint
CREATE TABLE "oauth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_user_id" varchar(64) NOT NULL,
	"login" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_identities_provider_user_unique" UNIQUE("provider","provider_user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"avatar_url" text,
	"blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"csrf_digest" "bytea" NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_sessions_token_digest_unique" UNIQUE("token_digest")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "registered_via_token_id" uuid;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "label" varchar(80) DEFAULT 'Legacy CLI token' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "create_idempotency_key" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "status" varchar(16) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "create_idempotency_key" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_user_created_at_idx" ON "audit_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_project_created_at_idx" ON "audit_events" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_project_id_id_unique" UNIQUE("project_id","id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_registered_via_token_project_fk" FOREIGN KEY ("registered_via_token_id","project_id") REFERENCES "public"."project_tokens"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_project_create_idempotency_unique" UNIQUE("project_id","create_idempotency_key");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_create_idempotency_unique" UNIQUE("owner_user_id","create_idempotency_key");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_check" CHECK ("projects"."status" IN ('active', 'archived'));--> statement-breakpoint
CREATE VIEW "observer"."audit_events" AS (select "id", "user_id", "project_id", "event_type", "metadata", "created_at" from "audit_events");--> statement-breakpoint
CREATE VIEW "observer"."connections" AS (select "id", "project_id", "label", "created_by_user_id", "expires_at", "last_used_at", "revoked_at", "created_at" from "project_tokens");--> statement-breakpoint
CREATE VIEW "observer"."users" AS (select "id", "display_name", "avatar_url", "blocked_at", "created_at", "updated_at" from "users");

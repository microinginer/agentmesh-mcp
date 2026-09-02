CREATE TABLE "project_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(32) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_role_check" CHECK ("project_memberships"."role" IN ('viewer', 'owner'))
);
--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_project_user_unique" ON "project_memberships" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_user_id_idx" ON "project_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_project_id_idx" ON "project_memberships" USING btree ("project_id");--> statement-breakpoint
INSERT INTO "project_memberships" (
	"project_id",
	"user_id",
	"role",
	"created_by"
)
SELECT
	"id",
	"owner_user_id",
	'owner',
	"owner_user_id"
FROM "projects"
WHERE "owner_user_id" IS NOT NULL
ON CONFLICT ("project_id", "user_id") DO NOTHING;

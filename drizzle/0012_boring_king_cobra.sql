CREATE TABLE "project_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"role" varchar(32) NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_by" uuid,
	"redeemed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_invitations_role_check" CHECK ("project_invitations"."role" = 'viewer'),
	CONSTRAINT "project_invitations_digest_length_check" CHECK (octet_length("project_invitations"."token_digest") = 32),
	CONSTRAINT "project_invitations_redemption_pair_check" CHECK (("project_invitations"."redeemed_by" IS NULL) = ("project_invitations"."redeemed_at" IS NULL)),
	CONSTRAINT "project_invitations_terminal_state_check" CHECK (NOT ("project_invitations"."redeemed_at" IS NOT NULL AND "project_invitations"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_token_digest_unique" ON "project_invitations" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "project_invitations_project_created_idx" ON "project_invitations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_invitations_expires_at_idx" ON "project_invitations" USING btree ("expires_at");
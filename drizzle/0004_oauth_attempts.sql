CREATE TABLE "oauth_attempts" (
	"attempt_digest" "bytea" PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oauth_attempts_expires_at_idx" ON "oauth_attempts" USING btree ("expires_at");
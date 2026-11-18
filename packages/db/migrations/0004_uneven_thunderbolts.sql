CREATE TABLE "session_operation" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"operation" text NOT NULL,
	"command_id" text NOT NULL,
	"digest" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"generation" text,
	"source_session_id" text,
	"frozen" jsonb,
	"native_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_session" ADD COLUMN "source_session_id" text;--> statement-breakpoint
ALTER TABLE "native_session" ADD COLUMN "source_through_seq" integer;--> statement-breakpoint
ALTER TABLE "session_operation" ADD CONSTRAINT "session_operation_actor_id_auth_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_operation" ADD CONSTRAINT "session_operation_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_operation_command_idx" ON "session_operation" USING btree ("actor_id","requirement_id","operation","command_id");
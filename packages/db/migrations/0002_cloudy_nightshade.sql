CREATE TABLE "command_receipt" (
	"actor_id" text NOT NULL,
	"scope" text NOT NULL,
	"operation" text NOT NULL,
	"command_id" text NOT NULL,
	"digest" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_receipt_actor_id_scope_operation_command_id_pk" PRIMARY KEY("actor_id","scope","operation","command_id")
);
--> statement-breakpoint
CREATE TABLE "requirement_event" (
	"id" text PRIMARY KEY NOT NULL,
	"requirement_id" text NOT NULL,
	"task_id" text,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"source" text NOT NULL,
	"command_id" text NOT NULL,
	"version" integer NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" text PRIMARY KEY NOT NULL,
	"requirement_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"acceptance" text DEFAULT '' NOT NULL,
	"assignee_id" text NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requirement_participant" DROP CONSTRAINT "requirement_participant_requirement_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "requirement_participant" ADD CONSTRAINT "requirement_participant_requirement_id_user_id_role_pk" PRIMARY KEY("requirement_id","user_id","role");--> statement-breakpoint
ALTER TABLE "requirement" ADD COLUMN "stage" text DEFAULT 'assignment' NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement" ADD COLUMN "context_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_event" ADD CONSTRAINT "requirement_event_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_id_auth_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requirement_event_scope_idx" ON "requirement_event" USING btree ("requirement_id","version");--> statement-breakpoint
CREATE INDEX "task_requirement_idx" ON "task" USING btree ("requirement_id");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM requirement_participant rp JOIN requirement r ON r.id=rp.requirement_id WHERE rp.role='manager' AND NOT EXISTS (SELECT 1 FROM project_member pm WHERE pm.project_id=r.project_id AND pm.user_id=rp.user_id AND pm.role IN ('requirement_manager','project_admin'))) THEN
    RAISE EXCEPTION 'Legacy manager participation has no verified project role';
  END IF;
  IF EXISTS (SELECT 1 FROM requirement_participant WHERE role NOT IN ('manager','project_admin','requirement_manager','developer','tester')) THEN
    RAISE EXCEPTION 'Unknown legacy participation role';
  END IF;
END $$;
--> statement-breakpoint
UPDATE requirement_participant rp SET role=CASE WHEN EXISTS (SELECT 1 FROM requirement r JOIN project_member pm ON pm.project_id=r.project_id AND pm.user_id=rp.user_id AND pm.role='requirement_manager' WHERE r.id=rp.requirement_id) THEN 'requirement_manager' ELSE 'project_admin' END WHERE rp.role='manager';
--> statement-breakpoint
INSERT INTO requirement_event(id,requirement_id,kind,actor_id,source,command_id,version,after) SELECT 'migration-0002-'||id,id,'requirement.initialized','migration','migration','migration-0002',1,jsonb_build_object('stage','assignment') FROM requirement;

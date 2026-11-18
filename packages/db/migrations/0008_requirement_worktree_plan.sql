CREATE TABLE "requirement_worktree_plan" (
	"requirement_id" text PRIMARY KEY NOT NULL,
	"repositories" jsonb NOT NULL,
	CONSTRAINT "requirement_worktree_plan_repositories" CHECK (jsonb_typeof("requirement_worktree_plan"."repositories") = 'array' and jsonb_array_length("requirement_worktree_plan"."repositories") between 1 and 16)
);
--> statement-breakpoint
ALTER TABLE "requirement_worktree_plan" ADD CONSTRAINT "requirement_worktree_plan_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE no action ON UPDATE no action;
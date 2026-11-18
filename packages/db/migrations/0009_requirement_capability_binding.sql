CREATE TABLE "requirement_capability_binding" (
	"requirement_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"template_id" text NOT NULL,
	"revision" integer NOT NULL
);
--> statement-breakpoint
DROP INDEX "capability_template_revision_project_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_id_project_idx" ON "requirement" USING btree ("id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capability_template_revision_project_idx" ON "capability_template_revision" USING btree ("project_id","template_id","revision");--> statement-breakpoint
ALTER TABLE "requirement_capability_binding" ADD CONSTRAINT "requirement_capability_binding_demand_fk" FOREIGN KEY ("requirement_id","project_id") REFERENCES "public"."requirement"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_capability_binding" ADD CONSTRAINT "requirement_capability_binding_template_fk" FOREIGN KEY ("project_id","template_id","revision") REFERENCES "public"."capability_template_revision"("project_id","template_id","revision") ON DELETE no action ON UPDATE no action;

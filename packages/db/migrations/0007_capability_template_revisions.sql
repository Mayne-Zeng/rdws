CREATE TABLE "capability_template_revision" (
	"template_id" text NOT NULL,
	"revision" integer NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	CONSTRAINT "capability_template_revision_template_id_revision_pk" PRIMARY KEY("template_id","revision"),
	CONSTRAINT "capability_template_revision_number" CHECK ("capability_template_revision"."revision" > 0),
	CONSTRAINT "capability_template_revision_name" CHECK (char_length("capability_template_revision"."name") between 1 and 80),
	CONSTRAINT "capability_template_revision_description" CHECK (char_length("capability_template_revision"."description") <= 1000),
	CONSTRAINT "capability_template_revision_choices" CHECK (jsonb_typeof("capability_template_revision"."capabilities") = 'array' and jsonb_array_length("capability_template_revision"."capabilities") <= 64)
);
--> statement-breakpoint
ALTER TABLE "capability_template_revision" ADD CONSTRAINT "capability_template_revision_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capability_template_revision_project_idx" ON "capability_template_revision" USING btree ("project_id","template_id","revision");
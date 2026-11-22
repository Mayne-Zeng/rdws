CREATE TABLE "project_model_allowlist" (
	"project_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"state" text NOT NULL,
	"revision" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_model_allowlist_project_id_provider_model_pk" PRIMARY KEY("project_id","provider","model"),
	CONSTRAINT "project_model_allowlist_reference" CHECK (char_length("project_model_allowlist"."provider") between 1 and 160 and char_length("project_model_allowlist"."model") between 1 and 160),
	CONSTRAINT "project_model_allowlist_state" CHECK ("project_model_allowlist"."state" in ('enabled', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "project_model_allowlist" ADD CONSTRAINT "project_model_allowlist_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER rdws_authority_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.project_model_allowlist FOR EACH STATEMENT EXECUTE FUNCTION rdws_authority.check_writer();--> statement-breakpoint
ALTER TABLE public.project_model_allowlist ENABLE ALWAYS TRIGGER rdws_authority_writer;
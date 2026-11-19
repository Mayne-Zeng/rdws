CREATE TABLE "requirement_write_lease" (
	"requirement_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"auth_session_id" text NOT NULL,
	"native_session_id" text NOT NULL,
	"generation" uuid NOT NULL,
	"phase" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"context_version" integer NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_write_lease_phase" CHECK ("requirement_write_lease"."phase" in ('held', 'draining', 'released') and ("requirement_write_lease"."phase" <> 'released' or "requirement_write_lease"."run_id" is null))
);
--> statement-breakpoint
ALTER TABLE "requirement_write_lease" ADD CONSTRAINT "requirement_write_lease_owner_id_auth_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_write_lease" ADD CONSTRAINT "requirement_write_lease_native_session_id_native_session_id_fk" FOREIGN KEY ("native_session_id") REFERENCES "public"."native_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_write_lease" ADD CONSTRAINT "requirement_write_lease_requirement_id_project_id_requirement_id_project_id_fk" FOREIGN KEY ("requirement_id","project_id") REFERENCES "public"."requirement"("id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['requirement_write_lease', 'task', 'command_receipt']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER rdws_authority_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION rdws_authority.check_writer()',
      relation
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER rdws_authority_writer', relation);
  END LOOP;
END
$$;

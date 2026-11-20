CREATE TABLE "session_model_first_write" (
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"native_session_id" text NOT NULL,
	"selection_request_id" text NOT NULL,
	"selection_revision" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"host_generation" uuid NOT NULL,
	"agent_generation" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"turn" integer NOT NULL,
	"step" integer NOT NULL,
	"step_seq" bigint NOT NULL,
	"note_seq" bigint NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "session_model_first_write_host_generation_attempt_id_pk" PRIMARY KEY("host_generation","attempt_id"),
	CONSTRAINT "session_model_first_write_coordinates" CHECK ("session_model_first_write"."turn" > 0 and "session_model_first_write"."step" > 0 and "session_model_first_write"."step_seq" >= 0 and
          "session_model_first_write"."note_seq" > "session_model_first_write"."step_seq" and "session_model_first_write"."note_seq" <= 9007199254740991),
	CONSTRAINT "session_model_first_write_state" CHECK (("session_model_first_write"."state" = 'prepared' and "session_model_first_write"."submitted_at" is null) or
          ("session_model_first_write"."state" = 'submitted' and "session_model_first_write"."submitted_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "session_model_first_write" ADD CONSTRAINT "session_model_first_write_dispatch_fk" FOREIGN KEY ("native_session_id","selection_request_id") REFERENCES "public"."session_prompt_dispatch"("native_session_id","request_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER rdws_authority_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.session_model_first_write FOR EACH STATEMENT EXECUTE FUNCTION rdws_authority.check_writer();
--> statement-breakpoint
ALTER TABLE public.session_model_first_write ENABLE ALWAYS TRIGGER rdws_authority_writer;

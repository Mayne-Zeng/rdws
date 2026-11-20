CREATE TABLE "session_model_selection" (
	"native_session_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"revision" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_model_selection_reference" CHECK (char_length("session_model_selection"."provider") between 1 and 160 and char_length("session_model_selection"."model") between 1 and 160)
);
--> statement-breakpoint
CREATE TABLE "session_prompt_dispatch" (
	"native_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"auth_session_id" text NOT NULL,
	"input_digest" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"selection_revision" uuid NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"host_generation" uuid,
	"peer_nonce" text,
	"lease_expires_at" timestamp with time zone,
	"accepted_seq" bigint,
	"accepted_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_prompt_dispatch_native_session_id_request_id_pk" PRIMARY KEY("native_session_id","request_id"),
	CONSTRAINT "session_prompt_dispatch_input" CHECK (char_length("session_prompt_dispatch"."request_id") between 1 and 128 and
          "session_prompt_dispatch"."input_digest" ~ '^[a-f0-9]{64}$' and
          char_length("session_prompt_dispatch"."provider") between 1 and 160 and
          char_length("session_prompt_dispatch"."model") between 1 and 160),
	CONSTRAINT "session_prompt_dispatch_ticket" CHECK (("session_prompt_dispatch"."state" = 'reserved' and "session_prompt_dispatch"."host_generation" is null and "session_prompt_dispatch"."peer_nonce" is null and "session_prompt_dispatch"."lease_expires_at" is null)
          or ("session_prompt_dispatch"."state" in ('pending', 'accepted') and "session_prompt_dispatch"."host_generation" is not null and
              "session_prompt_dispatch"."peer_nonce" is not null and char_length("session_prompt_dispatch"."peer_nonce") between 1 and 128 and "session_prompt_dispatch"."lease_expires_at" is not null)),
	CONSTRAINT "session_prompt_dispatch_observation" CHECK (("session_prompt_dispatch"."state" in ('reserved', 'pending') and "session_prompt_dispatch"."accepted_seq" is null and "session_prompt_dispatch"."accepted_message_id" is null)
          or ("session_prompt_dispatch"."state" = 'accepted' and "session_prompt_dispatch"."accepted_seq" is not null and "session_prompt_dispatch"."accepted_seq" between 0 and 9007199254740991 and
              "session_prompt_dispatch"."accepted_message_id" is not null and char_length("session_prompt_dispatch"."accepted_message_id") between 1 and 128))
);
--> statement-breakpoint
ALTER TABLE "session_model_selection" ADD CONSTRAINT "session_model_selection_native_session_id_native_session_id_fk" FOREIGN KEY ("native_session_id") REFERENCES "public"."native_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_prompt_dispatch" ADD CONSTRAINT "session_prompt_dispatch_native_session_id_native_session_id_fk" FOREIGN KEY ("native_session_id") REFERENCES "public"."native_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_prompt_dispatch" ADD CONSTRAINT "session_prompt_dispatch_actor_id_auth_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_prompt_dispatch" ADD CONSTRAINT "session_prompt_dispatch_requirement_project_fk" FOREIGN KEY ("requirement_id","project_id") REFERENCES "public"."requirement"("id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER rdws_authority_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.session_model_selection FOR EACH STATEMENT EXECUTE FUNCTION rdws_authority.check_writer();
--> statement-breakpoint
ALTER TABLE public.session_model_selection ENABLE ALWAYS TRIGGER rdws_authority_writer;
--> statement-breakpoint
CREATE TRIGGER rdws_authority_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.session_prompt_dispatch FOR EACH STATEMENT EXECUTE FUNCTION rdws_authority.check_writer();
--> statement-breakpoint
ALTER TABLE public.session_prompt_dispatch ENABLE ALWAYS TRIGGER rdws_authority_writer;

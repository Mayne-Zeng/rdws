CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TABLE "audit"."session_log_anchor" (
	"project_id" text NOT NULL,
	"session_id" text NOT NULL,
	"bucket_sha256" text NOT NULL,
	"journal_name" text NOT NULL,
	"through_byte" bigint NOT NULL,
	"sha256" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_log_anchor_key" PRIMARY KEY("project_id","session_id","bucket_sha256","journal_name","through_byte"),
	CONSTRAINT "session_log_anchor_project" CHECK ("audit"."session_log_anchor"."project_id" collate "C" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "session_log_anchor_session" CHECK ("audit"."session_log_anchor"."session_id" collate "C" ~ '^session-[a-zA-Z0-9-]{1,120}$'),
	CONSTRAINT "session_log_anchor_digest" CHECK ("audit"."session_log_anchor"."sha256" collate "C" ~ '^[a-f0-9]{64}$' and "audit"."session_log_anchor"."bucket_sha256" collate "C" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "session_log_anchor_cutoff" CHECK ("audit"."session_log_anchor"."through_byte" between 1 and 9007199254740991),
	CONSTRAINT "session_log_anchor_generation" CHECK ("audit"."session_log_anchor"."journal_name" collate "C" ~ '^session([.]v[1-9][0-9]{0,15})?[.]jsonl([.]zstd)?$'
        and coalesce(substring("audit"."session_log_anchor"."journal_name" from '^session[.]v([1-9][0-9]{0,15})[.]jsonl')::numeric, 0) <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "audit"."session_log_anchor" ADD CONSTRAINT "session_log_anchor_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit"."session_log_anchor" ADD CONSTRAINT "session_log_anchor_session_id_native_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."native_session"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION audit.check_session_log_source() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  demand_id text;
BEGIN
  SELECT requirement_id INTO demand_id
  FROM public.native_session WHERE id = NEW.session_id;

  PERFORM 1 FROM public.requirement
  WHERE id = demand_id AND project_id = NEW.project_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown session log source' USING ERRCODE = '23503';
  END IF;

  PERFORM 1 FROM public.native_session
  WHERE id = NEW.session_id AND requirement_id = demand_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown session log source' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.check_session_log_source() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER anchor_current_session_source BEFORE INSERT ON audit.session_log_anchor
FOR EACH ROW EXECUTE FUNCTION audit.check_session_log_source();
--> statement-breakpoint
ALTER TABLE audit.session_log_anchor ENABLE ALWAYS TRIGGER anchor_current_session_source;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    WITH objects AS (
      SELECT nspowner AS owner, coalesce(nspacl, acldefault('n', nspowner)) AS acl
      FROM pg_namespace WHERE nspname = 'audit'
      UNION ALL
      SELECT relowner, coalesce(relacl, acldefault('r', relowner))
      FROM pg_class WHERE oid = 'audit.session_log_anchor'::regclass
      UNION ALL
      SELECT proowner, coalesce(proacl, acldefault('f', proowner))
      FROM pg_proc WHERE oid = 'audit.check_session_log_source()'::regprocedure
      UNION ALL
      SELECT relowner, attacl
      FROM pg_class JOIN pg_attribute ON attrelid = pg_class.oid
      WHERE pg_class.oid = 'audit.session_log_anchor'::regclass
        AND attnum > 0 AND NOT attisdropped
    )
    SELECT 1 FROM objects CROSS JOIN LATERAL aclexplode(acl) AS entry
    WHERE entry.grantee <> objects.owner
  ) THEN
    RAISE EXCEPTION 'Unexpected default access to session log anchors';
  END IF;
END
$$;

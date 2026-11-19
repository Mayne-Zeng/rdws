CREATE SCHEMA "rdws_authority";
--> statement-breakpoint
CREATE TABLE "rdws_authority"."owner" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"ticket_digest" text,
	"proof_digest" text,
	"generation" uuid,
	CONSTRAINT "authority_owner_singleton" CHECK ("rdws_authority"."owner"."singleton"),
	CONSTRAINT "authority_owner_state" CHECK (("rdws_authority"."owner"."generation" IS NULL) = ("rdws_authority"."owner"."proof_digest" IS NULL)
        AND ("rdws_authority"."owner"."generation" IS NULL OR "rdws_authority"."owner"."ticket_digest" IS NULL)
        AND ("rdws_authority"."owner"."managed" OR ("rdws_authority"."owner"."generation" IS NULL AND "rdws_authority"."owner"."ticket_digest" IS NULL))),
	CONSTRAINT "authority_owner_ticket_digest" CHECK ("rdws_authority"."owner"."ticket_digest" COLLATE "C" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "authority_owner_proof_digest" CHECK ("rdws_authority"."owner"."proof_digest" COLLATE "C" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
INSERT INTO rdws_authority.owner (singleton) VALUES (true);
--> statement-breakpoint
REVOKE ALL ON SCHEMA rdws_authority FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE rdws_authority.owner FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION rdws_authority.admit_owner(paused boolean, ticket text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  enabled boolean;
  proof text := current_setting('rdws.runtime_authority_proof', true);
  claimed uuid;
BEGIN
  IF NOT rdws_authority.acl_is_safe(session_user) THEN
    RAISE EXCEPTION 'Runtime authority permissions are not safe' USING ERRCODE = '42501';
  END IF;
  SELECT managed INTO STRICT enabled FROM rdws_authority.owner WHERE singleton;
  IF NOT enabled AND ticket IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT enabled OR paused IS DISTINCT FROM true
     OR coalesce(ticket, '') COLLATE "C" !~ '^[0-9a-f]{64}$'
     OR coalesce(proof, '') COLLATE "C" !~ '^[0-9a-f]{64}$'
     OR proof = ticket
     OR current_setting('synchronous_commit') <> 'on'
     OR current_setting('fsync') <> 'on'
  THEN
    RAISE EXCEPTION 'Runtime authority admission denied' USING ERRCODE = '55006';
  END IF;
  UPDATE rdws_authority.owner
  SET ticket_digest = NULL,
      proof_digest = encode(sha256(convert_to(proof, 'UTF8')), 'hex'),
      generation = gen_random_uuid()
  WHERE singleton AND managed AND generation IS NULL
    AND ticket_digest = encode(sha256(convert_to(ticket, 'UTF8')), 'hex')
  RETURNING generation INTO claimed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Runtime authority admission denied' USING ERRCODE = '55006';
  END IF;
  RETURN claimed;
END
$$;
--> statement-breakpoint
CREATE FUNCTION rdws_authority.release_owner(expected_generation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  proof text := current_setting('rdws.runtime_authority_proof', true);
BEGIN
  IF NOT rdws_authority.acl_is_safe(session_user)
     OR current_setting('synchronous_commit') <> 'on'
     OR current_setting('fsync') <> 'on'
  THEN
    RAISE EXCEPTION 'Runtime authority release denied' USING ERRCODE = '55006';
  END IF;
  UPDATE rdws_authority.owner
  SET proof_digest = NULL, generation = NULL
  WHERE singleton AND managed AND generation = expected_generation
    AND proof_digest = encode(sha256(convert_to(proof, 'UTF8')), 'hex');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Runtime authority release denied' USING ERRCODE = '55006';
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION rdws_authority.check_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  state rdws_authority.owner%ROWTYPE;
  proof text := current_setting('rdws.runtime_authority_proof', true);
BEGIN
  SELECT * INTO STRICT state FROM rdws_authority.owner WHERE singleton FOR SHARE;
  IF state.managed AND (
    state.generation IS NULL OR state.proof_digest
      IS DISTINCT FROM encode(sha256(convert_to(proof, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'Runtime authority write denied' USING ERRCODE = '55006';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rdws_authority.admit_owner(boolean, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rdws_authority.release_owner(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rdws_authority.check_writer() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION rdws_authority.acl_is_safe(application_role name) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH objects AS (
    SELECT 'schema' AS kind, nspowner AS owner,
      coalesce(nspacl, acldefault('n', nspowner)) AS acl
    FROM pg_namespace WHERE nspname = 'rdws_authority'
    UNION ALL
    SELECT 'table', relowner, coalesce(relacl, acldefault('r', relowner))
    FROM pg_class WHERE oid = 'rdws_authority.owner'::regclass
    UNION ALL
    SELECT CASE
        WHEN p.oid = to_regprocedure('rdws_authority.admit_owner(boolean,text)')
          OR p.oid = to_regprocedure('rdws_authority.release_owner(uuid)')
        THEN 'entrypoint' ELSE 'internal' END,
      p.proowner, coalesce(p.proacl, acldefault('f', p.proowner))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'rdws_authority'
    UNION ALL
    SELECT 'column', relowner, attacl
    FROM pg_class JOIN pg_attribute ON attrelid = pg_class.oid
    WHERE pg_class.oid = 'rdws_authority.owner'::regclass
      AND attnum > 0 AND NOT attisdropped
  )
  SELECT NOT EXISTS (
    SELECT FROM objects WHERE owner <> current_user::regrole::oid
  ) AND NOT EXISTS (
    SELECT FROM objects CROSS JOIN LATERAL aclexplode(acl) AS grant_entry
    WHERE grant_entry.grantee <> objects.owner
      AND NOT coalesce(
        grant_entry.grantee = (SELECT oid FROM pg_roles WHERE rolname = application_role)
        AND grant_entry.grantor = objects.owner AND NOT grant_entry.is_grantable
        AND ((objects.kind = 'schema' AND grant_entry.privilege_type = 'USAGE')
          OR (objects.kind = 'entrypoint' AND grant_entry.privilege_type = 'EXECUTE')),
        false
      )
  ) AND (
    application_role IS NULL OR coalesce((
      SELECT r.rolcanlogin
        AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
        AND NOT has_database_privilege(r.oid, current_database(), 'CREATE')
        AND NOT has_schema_privilege(r.oid, 'rdws_authority', 'CREATE')
        AND NOT has_table_privilege(r.oid, 'rdws_authority.owner', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        AND NOT has_any_column_privilege(r.oid, 'rdws_authority.owner', 'SELECT,INSERT,UPDATE,REFERENCES')
        AND NOT has_parameter_privilege(r.oid, 'session_replication_role', 'SET')
        AND NOT EXISTS (
          SELECT FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE t.tgfoid = 'rdws_authority.check_writer()'::regprocedure AND c.relowner = r.oid
        )
      FROM pg_roles r WHERE r.rolname = application_role
    ), false)
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rdws_authority.acl_is_safe(name) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT rdws_authority.acl_is_safe(NULL) THEN
    RAISE EXCEPTION 'Runtime authority has unexpected default privileges' USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'auth_user', 'auth_session', 'auth_account', 'auth_verification',
    'project', 'project_member', 'requirement', 'requirement_participant',
    'native_session'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER rdws_authority_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION rdws_authority.check_writer()',
      relation
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER rdws_authority_writer', relation);
  END LOOP;
END
$$;

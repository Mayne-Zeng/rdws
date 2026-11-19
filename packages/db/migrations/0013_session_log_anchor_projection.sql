CREATE FUNCTION public.read_session_log_anchors(
  project_id text, requirement_id text, native_session_id text,
  actor_id text, login_id text, before_at timestamptz, before_id text
)
RETURNS TABLE (anchor_id text, through_byte bigint, sha256 text, recorded_at text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT candidate.anchor_id, candidate.through_byte, candidate.sha256,
    to_char(candidate.event_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  FROM (
    SELECT encode(sha256(convert_to(jsonb_build_array(
        anchor.project_id, anchor.session_id, anchor.bucket_sha256,
        anchor.journal_name, anchor.through_byte
      )::text, 'UTF8')), 'hex') AS anchor_id,
      anchor.through_byte, anchor.sha256, anchor.recorded_at AS event_at
    FROM audit.session_log_anchor AS anchor
    WHERE anchor.project_id = $1 AND anchor.session_id = $3
      AND anchor.recorded_at >= TIMESTAMPTZ '1000-01-01 00:00:00+00'
      AND anchor.recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
      AND EXISTS (
        SELECT 1 FROM public.auth_session AS login
        JOIN public.auth_user AS account ON account.id = login.user_id
        WHERE login.id = $5 AND account.id = $4 AND account.active
          AND login.auth_epoch = account.auth_epoch
          AND login.expires_at > statement_timestamp()
      )
      AND EXISTS (
        SELECT 1 FROM public.native_session AS native
        JOIN public.requirement AS demand ON demand.id = native.requirement_id
        JOIN public.project_member AS member ON member.project_id = demand.project_id
        WHERE native.id = $3 AND demand.id = $2 AND demand.project_id = $1
          AND member.user_id = $4
          AND (member.role = 'project_admin' OR EXISTS (
            SELECT 1 FROM public.requirement_participant AS participant
            WHERE participant.requirement_id = demand.id AND participant.user_id = $4
              AND participant.role = member.role
          ))
      )
  ) AS candidate
  WHERE ($6 IS NULL AND $7 IS NULL) OR (
    $7 COLLATE "C" ~ '^[a-f0-9]{64}$'
      AND (candidate.event_at, candidate.anchor_id COLLATE "C") < ($6, $7 COLLATE "C")
  )
  ORDER BY candidate.event_at DESC, candidate.anchor_id COLLATE "C" DESC
  LIMIT 26;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_session_log_anchors(text,text,text,text,text,timestamptz,text) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) AS acl
    WHERE proc.oid = 'public.read_session_log_anchors(text,text,text,text,text,timestamptz,text)'::regprocedure
      AND acl.grantee <> proc.proowner
  ) THEN
    RAISE EXCEPTION 'Unexpected default access to session log anchor projection';
  END IF;
END
$$;

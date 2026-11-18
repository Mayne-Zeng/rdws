ALTER TABLE "auth_session" ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE FUNCTION rdws_check_session_epoch() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1 FROM public.auth_user
  WHERE id = NEW.user_id AND active AND auth_epoch = NEW.auth_epoch
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RDWS account authorization changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER auth_session_current_epoch BEFORE INSERT ON auth_session
FOR EACH ROW EXECUTE FUNCTION rdws_check_session_epoch();

-- =====================================================================
-- Ultimate Group Asset Tracker — database schema & secure API
-- Applied automatically by the "migrate" container on every start. Safe to re-run.
--
-- What it does:
--   * PINs are stored only as bcrypt hashes and checked on the server.
--     The browser never receives any PIN.
--   * Login gives a 12-hour session token. Every read/write needs it.
--   * 5 wrong PINs locks that account for 15 minutes.
--   * The public anon key can no longer read or write tables directly;
--     it can only call the ug_* functions below.
--   * Server enforces permissions: deleting assets needs "Edit Assets",
--     changing staff/PINs needs "Master Admin" (canManagePermissions).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ---------- Tables (same shape the app already uses) ----------
CREATE TABLE IF NOT EXISTS public.tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  status TEXT DEFAULT 'In Stores',
  condition TEXT DEFAULT 'Good',
  location TEXT,
  holder TEXT,
  current_holder TEXT,
  job_ref TEXT,
  checkout_date TIMESTAMPTZ,
  checkout_time TIMESTAMPTZ,
  expected_return TIMESTAMPTZ,
  notes TEXT,
  condition_notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'In Stores';
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS condition TEXT DEFAULT 'Good';
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS holder TEXT;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS current_holder TEXT;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS job_ref TEXT;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS checkout_date TIMESTAMPTZ;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS checkout_time TIMESTAMPTZ;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS expected_return TIMESTAMPTZ;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS condition_notes TEXT;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.staff_accounts (
  name TEXT PRIMARY KEY,
  role TEXT DEFAULT 'Technician',
  active BOOLEAN DEFAULT TRUE,
  permissions JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'Technician';
ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS pin_changed_at TIMESTAMPTZ;
ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS pin_changed_by TEXT;
ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS failed_attempts INT DEFAULT 0;
ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.activity_logs (
  id SERIAL PRIMARY KEY,
  time_str TEXT,
  action TEXT,
  tool_id TEXT,
  asset_id TEXT,
  tool_name TEXT,
  asset_name TEXT,
  tech TEXT,
  holder TEXT,
  job TEXT,
  job_ref TEXT,
  condition TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS time_str TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS tool_id TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS asset_id TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS tool_name TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS asset_name TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS tech TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS holder TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS job TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS job_ref TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS condition TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS performed_by TEXT;

-- Submitted service schedules are saved as signed PDF files on the TrueNAS share.
CREATE TABLE IF NOT EXISTS public.job_cards (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL CHECK (company IN ('SINABO', 'UES', 'USS')),
  file_name TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  customer TEXT,
  service_schedule_no TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
REVOKE ALL ON public.job_cards FROM PUBLIC, anon, authenticated;

-- Job card assistants are a separate roster from app login accounts.
CREATE TABLE IF NOT EXISTS public.jobcard_personnel (
  name TEXT PRIMARY KEY,
  added_by TEXT REFERENCES public.staff_accounts(name) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS jobcard_personnel_name_ci_idx ON public.jobcard_personnel (LOWER(name));
ALTER TABLE public.jobcard_personnel ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.jobcard_personnel FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.staff_sessions (
  token TEXT PRIMARY KEY,
  staff_name TEXT NOT NULL REFERENCES public.staff_accounts(name) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- ---------- Migrate plain-text PINs to hashes, then remove them ----------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'staff_accounts' AND column_name = 'pin') THEN
    EXECUTE $m$
      UPDATE public.staff_accounts
         SET pin_hash = extensions.crypt(COALESCE(NULLIF(trim(pin), ''), '1234'), extensions.gen_salt('bf'))
       WHERE pin_hash IS NULL
    $m$;
    ALTER TABLE public.staff_accounts DROP COLUMN pin;
  END IF;
END $$;
UPDATE public.staff_accounts
   SET pin_hash = extensions.crypt('1234', extensions.gen_salt('bf'))
 WHERE pin_hash IS NULL;

-- Old versions also copied every staff PIN into a hidden row in tools. Remove it.
DELETE FROM public.tools WHERE id = '__UG_STAFF_CONFIG__';

-- ---------- Lock down direct table access ----------
ALTER TABLE public.tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all public access to tools" ON public.tools;
DROP POLICY IF EXISTS "Allow all public access to staff" ON public.staff_accounts;
DROP POLICY IF EXISTS "Allow all public access to logs" ON public.activity_logs;

REVOKE ALL ON public.tools, public.staff_accounts, public.activity_logs, public.staff_sessions FROM anon, authenticated;
DO $$
BEGIN
  IF to_regclass('public.activity_logs_id_seq') IS NOT NULL THEN
    REVOKE ALL ON SEQUENCE public.activity_logs_id_seq FROM anon, authenticated;
  END IF;
END $$;

-- ---------- Helpers (not callable from the browser) ----------
CREATE OR REPLACE FUNCTION public.ug_has_perm(p_role TEXT, p_perms JSONB, p_perm TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (p_perms ->> p_perm)::BOOLEAN,
    CASE p_perm
      WHEN 'canManagePermissions' THEN p_role = 'Master Admin'
      WHEN 'canEditRegister'      THEN p_role IN ('Master Admin', 'Manager')
      WHEN 'canAssignOthers'      THEN p_role IN ('Master Admin', 'Manager', 'Storeman')
      WHEN 'canViewDashboard'     THEN p_role IN ('Master Admin', 'Manager', 'Storeman')
      ELSE FALSE
    END
  );
$$;

CREATE OR REPLACE FUNCTION public.ug_require_session(p_token TEXT, p_perm TEXT DEFAULT NULL)
RETURNS public.staff_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  acc public.staff_accounts;
BEGIN
  SELECT a.* INTO acc
    FROM public.staff_sessions s
    JOIN public.staff_accounts a ON a.name = s.staff_name
   WHERE s.token = p_token AND s.expires_at > NOW();
  IF NOT FOUND OR acc.active IS NOT TRUE THEN
    RAISE EXCEPTION 'UG_SESSION_EXPIRED' USING ERRCODE = '28000';
  END IF;
  IF p_perm IS NOT NULL AND NOT public.ug_has_perm(acc.role, acc.permissions, p_perm) THEN
    RAISE EXCEPTION 'UG_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN acc;
END $$;

-- ---------- Public: names for the login dropdown (no PINs) ----------
CREATE OR REPLACE FUNCTION public.ug_list_staff()
RETURNS TABLE (name TEXT, role TEXT, active BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT name, role, active FROM public.staff_accounts ORDER BY name;
$$;

-- ---------- Public: first-time setup only (works only while roster is empty) ----------
CREATE OR REPLACE FUNCTION public.ug_bootstrap_staff(p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE n INT;
BEGIN
  LOCK TABLE public.staff_accounts IN EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.staff_accounts) THEN
    RAISE EXCEPTION 'UG_ALREADY_SETUP' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.staff_accounts (name, role, active, permissions, pin_hash)
  SELECT r->>'name', COALESCE(r->>'role', 'Technician'), COALESCE((r->>'active')::BOOLEAN, TRUE),
         COALESCE(r->'permissions', '{}'::jsonb), crypt('1234', gen_salt('bf'))
    FROM jsonb_array_elements(p_rows) r
   WHERE COALESCE(trim(r->>'name'), '') <> '';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------- Public: login ----------
CREATE OR REPLACE FUNCTION public.ug_login(p_name TEXT, p_pin TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  acc public.staff_accounts;
  tok TEXT;
BEGIN
  SELECT * INTO acc FROM public.staff_accounts WHERE name = p_name FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'bad_credentials');
  END IF;
  IF acc.active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'suspended');
  END IF;
  IF acc.locked_until IS NOT NULL AND acc.locked_until > NOW() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'locked',
      'minutes', CEIL(EXTRACT(EPOCH FROM (acc.locked_until - NOW())) / 60));
  END IF;
  IF acc.pin_hash IS NULL OR acc.pin_hash <> crypt(COALESCE(p_pin, ''), acc.pin_hash) THEN
    UPDATE public.staff_accounts
       SET failed_attempts = COALESCE(failed_attempts, 0) + 1,
           locked_until = CASE WHEN COALESCE(failed_attempts, 0) + 1 >= 5
                               THEN NOW() + INTERVAL '15 minutes' ELSE NULL END
     WHERE name = acc.name;
    RETURN jsonb_build_object('ok', FALSE, 'error', 'bad_credentials');
  END IF;

  UPDATE public.staff_accounts SET failed_attempts = 0, locked_until = NULL WHERE name = acc.name;
  DELETE FROM public.staff_sessions WHERE expires_at < NOW();
  tok := encode(gen_random_bytes(32), 'hex');
  INSERT INTO public.staff_sessions (token, staff_name, expires_at)
  VALUES (tok, acc.name, NOW() + INTERVAL '12 hours');

  RETURN jsonb_build_object('ok', TRUE, 'token', tok, 'name', acc.name, 'role', acc.role,
                            'active', acc.active, 'permissions', acc.permissions);
END $$;

CREATE OR REPLACE FUNCTION public.ug_logout(p_token TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.staff_sessions WHERE token = p_token;
$$;

-- ---------- Signed-in: reads ----------
CREATE OR REPLACE FUNCTION public.ug_get_tools(p_token TEXT)
RETURNS SETOF public.tools
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.ug_require_session(p_token);
  RETURN QUERY SELECT * FROM public.tools WHERE id <> '__UG_STAFF_CONFIG__' ORDER BY id;
END $$;

CREATE OR REPLACE FUNCTION public.ug_get_staff(p_token TEXT)
RETURNS TABLE (name TEXT, role TEXT, active BOOLEAN, permissions JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.ug_require_session(p_token);
  RETURN QUERY SELECT a.name, a.role, a.active, a.permissions FROM public.staff_accounts a ORDER BY a.name;
END $$;

CREATE OR REPLACE FUNCTION public.ug_get_logs(p_token TEXT, p_limit INT DEFAULT 20)
RETURNS SETOF public.activity_logs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.ug_require_session(p_token);
  RETURN QUERY SELECT * FROM public.activity_logs ORDER BY id DESC LIMIT LEAST(GREATEST(p_limit, 1), 500);
END $$;

-- ---------- Signed-in: writes ----------
CREATE OR REPLACE FUNCTION public.ug_upsert_tools(p_token TEXT, p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n INT;
  acc public.staff_accounts;
BEGIN
  acc := public.ug_require_session(p_token);

  -- A checked-out tool may only be returned by its assigned holder, a Storeman,
  -- or a Master Admin. Enforce this in the API as well as in the browser UI.
  IF COALESCE(acc.role, '') NOT IN ('Master Admin', 'Storeman') AND EXISTS (
    SELECT 1
      FROM jsonb_populate_recordset(NULL::public.tools, p_rows) incoming
      JOIN public.tools existing ON existing.id = incoming.id
     WHERE existing.status = 'Checked Out'
       AND existing.current_holder IS DISTINCT FROM acc.name
       AND (incoming.status IS DISTINCT FROM existing.status
            OR incoming.current_holder IS DISTINCT FROM existing.current_holder)
  ) THEN
    RAISE EXCEPTION 'UG_FORBIDDEN_RETURN' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.tools AS t
    (id, name, category, status, condition, location, holder, current_holder, job_ref,
     checkout_date, checkout_time, expected_return, notes, condition_notes, updated_at)
  SELECT r.id, r.name, r.category, r.status, r.condition, r.location, r.holder, r.current_holder, r.job_ref,
         r.checkout_date, r.checkout_time, r.expected_return, r.notes, r.condition_notes, COALESCE(r.updated_at, NOW())
    FROM jsonb_populate_recordset(NULL::public.tools, p_rows) r
   WHERE r.id IS NOT NULL AND r.id <> '__UG_STAFF_CONFIG__' AND r.name IS NOT NULL
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category, status = EXCLUDED.status,
    condition = EXCLUDED.condition, location = EXCLUDED.location, holder = EXCLUDED.holder,
    current_holder = EXCLUDED.current_holder, job_ref = EXCLUDED.job_ref,
    checkout_date = EXCLUDED.checkout_date, checkout_time = EXCLUDED.checkout_time,
    expected_return = EXCLUDED.expected_return, notes = EXCLUDED.notes,
    condition_notes = EXCLUDED.condition_notes, updated_at = EXCLUDED.updated_at;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.ug_delete_tool(p_token TEXT, p_id TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.ug_require_session(p_token, 'canEditRegister');
  DELETE FROM public.tools WHERE id = p_id;
END $$;

CREATE OR REPLACE FUNCTION public.ug_add_log(p_token TEXT, p_entry JSONB)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE acc public.staff_accounts;
BEGIN
  acc := public.ug_require_session(p_token);
  INSERT INTO public.activity_logs
    (time_str, action, tool_id, asset_id, tool_name, asset_name, tech, holder, job, job_ref, condition, performed_by)
  VALUES (p_entry->>'time_str', p_entry->>'action', p_entry->>'tool_id', p_entry->>'tool_id',
          p_entry->>'tool_name', p_entry->>'tool_name', p_entry->>'tech', p_entry->>'tech',
          p_entry->>'job', p_entry->>'job', p_entry->>'condition', acc.name);
END $$;

-- Rows: [{name, role, active, permissions, pin?}] — pin only when it is being changed.
CREATE OR REPLACE FUNCTION public.ug_upsert_staff(p_token TEXT, p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE n INT; acc public.staff_accounts;
BEGIN
  acc := public.ug_require_session(p_token, 'canManagePermissions');
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r
              WHERE r ? 'pin' AND COALESCE(r->>'pin', '') !~ '^\d{4}$') THEN
    RAISE EXCEPTION 'UG_BAD_PIN' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.staff_accounts AS a (name, role, active, permissions, pin_hash, updated_at)
  SELECT r->>'name', COALESCE(r->>'role', 'Technician'), COALESCE((r->>'active')::BOOLEAN, TRUE),
         COALESCE(r->'permissions', '{}'::jsonb),
         CASE WHEN r ? 'pin' THEN crypt(r->>'pin', gen_salt('bf')) ELSE NULL END, NOW()
    FROM jsonb_array_elements(p_rows) r
   WHERE COALESCE(trim(r->>'name'), '') <> ''
  ON CONFLICT (name) DO UPDATE SET
    role = EXCLUDED.role, active = EXCLUDED.active, permissions = EXCLUDED.permissions, updated_at = NOW(),
    pin_hash = COALESCE(EXCLUDED.pin_hash, a.pin_hash),
    failed_attempts = CASE WHEN EXCLUDED.pin_hash IS NULL THEN a.failed_attempts ELSE 0 END,
    locked_until    = CASE WHEN EXCLUDED.pin_hash IS NULL THEN a.locked_until    ELSE NULL END,
    -- Audit trail: who last changed this PIN, and when (visible in Adminer)
    pin_changed_at  = CASE WHEN EXCLUDED.pin_hash IS NULL THEN a.pin_changed_at  ELSE NOW() END,
    pin_changed_by  = CASE WHEN EXCLUDED.pin_hash IS NULL THEN a.pin_changed_by  ELSE acc.name END;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- New staff added without a PIN get the default 1234
  UPDATE public.staff_accounts SET pin_hash = crypt('1234', gen_salt('bf')) WHERE pin_hash IS NULL;
  DELETE FROM public.staff_sessions s USING public.staff_accounts a
   WHERE s.staff_name = a.name AND a.active IS NOT TRUE;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.ug_delete_staff(p_token TEXT, p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE acc public.staff_accounts;
BEGIN
  acc := public.ug_require_session(p_token, 'canManagePermissions');
  IF acc.name = p_name THEN
    RAISE EXCEPTION 'UG_CANNOT_DELETE_SELF' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.staff_accounts WHERE name = p_name;
END $$;

CREATE OR REPLACE FUNCTION public.ug_list_jobcard_personnel(p_token TEXT)
RETURNS TABLE(name TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE acc public.staff_accounts;
BEGIN
  acc := public.ug_require_session(p_token);
  RETURN QUERY SELECT p.name FROM public.jobcard_personnel p ORDER BY p.name;
END $$;

CREATE OR REPLACE FUNCTION public.ug_add_jobcard_personnel(p_token TEXT, p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  acc public.staff_accounts;
  clean_name TEXT;
  saved_name TEXT;
BEGIN
  acc := public.ug_require_session(p_token);
  clean_name := regexp_replace(btrim(COALESCE(p_name, '')), '\s+', ' ', 'g');
  IF clean_name = '' OR char_length(clean_name) > 120 THEN
    RAISE EXCEPTION 'UG_BAD_JOBCARD_PERSONNEL_NAME' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.jobcard_personnel (name, added_by)
  VALUES (clean_name, acc.name)
  ON CONFLICT DO NOTHING;
  SELECT p.name INTO saved_name
    FROM public.jobcard_personnel p
   WHERE LOWER(p.name) = LOWER(clean_name)
   LIMIT 1;
  RETURN saved_name;
END $$;

CREATE OR REPLACE FUNCTION public.ug_delete_jobcard_personnel(p_token TEXT, p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  acc public.staff_accounts;
  deleted_count INT;
BEGIN
  acc := public.ug_require_session(p_token);
  IF acc.role IS DISTINCT FROM 'Master Admin' THEN
    RAISE EXCEPTION 'UG_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.jobcard_personnel WHERE LOWER(name) = LOWER(BTRIM(COALESCE(p_name, '')));
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count > 0;
END $$;

-- ---------- Who may call what ----------
REVOKE ALL ON FUNCTION public.ug_has_perm(TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ug_require_session(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.ug_list_staff(), public.ug_bootstrap_staff(JSONB), public.ug_login(TEXT, TEXT), public.ug_logout(TEXT),
  public.ug_get_tools(TEXT), public.ug_get_staff(TEXT), public.ug_get_logs(TEXT, INT),
  public.ug_upsert_tools(TEXT, JSONB), public.ug_delete_tool(TEXT, TEXT), public.ug_add_log(TEXT, JSONB),
  public.ug_upsert_staff(TEXT, JSONB), public.ug_delete_staff(TEXT, TEXT),
  public.ug_list_jobcard_personnel(TEXT), public.ug_add_jobcard_personnel(TEXT, TEXT),
  public.ug_delete_jobcard_personnel(TEXT, TEXT)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.ug_list_staff(), public.ug_bootstrap_staff(JSONB), public.ug_login(TEXT, TEXT), public.ug_logout(TEXT),
  public.ug_get_tools(TEXT), public.ug_get_staff(TEXT), public.ug_get_logs(TEXT, INT),
  public.ug_upsert_tools(TEXT, JSONB), public.ug_delete_tool(TEXT, TEXT), public.ug_add_log(TEXT, JSONB),
  public.ug_upsert_staff(TEXT, JSONB), public.ug_delete_staff(TEXT, TEXT),
  public.ug_list_jobcard_personnel(TEXT), public.ug_add_jobcard_personnel(TEXT, TEXT),
  public.ug_delete_jobcard_personnel(TEXT, TEXT)
TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- Roles PostgREST needs (the standard role names expected by PostgREST).
-- Run by the "migrate" container with:  psql -v auth_pw=<AUTHENTICATOR_PASSWORD> -f 01-roles.sql
--   anon           : what every web request runs as. Can only call the ug_* functions.
--   authenticated  : unused here; exists so the schema script's GRANTs succeed.
--   authenticator  : the login PostgREST connects with; it switches to anon per request.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN;
  END IF;
END $$;

-- Password comes from the compose file; re-applied each start so changing it there works.
ALTER ROLE authenticator WITH LOGIN NOINHERIT PASSWORD :'auth_pw';
GRANT anon TO authenticator;

CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

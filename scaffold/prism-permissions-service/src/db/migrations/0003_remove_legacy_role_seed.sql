-- Purge the legacy demo seed that PRISM self-healed on every service boot.
--
-- Background: 0002_tool_grants.sql previously inserted lowercase 'staff' and
-- 'viewer' role grants with fixed ids (seed-*). runMigrations() executes every
-- migration on each startup, so those rows reappeared after any deletion —
-- including a portal full-replace PUT. The portal's canonical role is now
-- "Staff" (capital S); the original lowercase "staff" role was deleted in the
-- portal and must not exist in PRISM.
--
-- We delete ONLY the deterministic seed ids. Grants written by the portal use
-- random UUIDs, so this preserves portal-managed data. After this migration,
-- if a lowercase 'staff' role grant still appears, it has a non-seed id and was
-- therefore posted by the portal — not originated by PRISM.
DELETE FROM "tool_grant"
WHERE "id" IN ('seed-staff-convert', 'seed-staff-visualiser', 'seed-viewer-visualiser');

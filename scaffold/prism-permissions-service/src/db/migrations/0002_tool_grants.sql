CREATE TABLE IF NOT EXISTS "tool_grant" (
  "id" text PRIMARY KEY NOT NULL,
  "principal_type" text NOT NULL,
  "principal_ref" text NOT NULL,
  "tool" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tool_grant_principal_tool_idx"
  ON "tool_grant" ("principal_type", "principal_ref", "tool");

-- NOTE: No demo seed rows. Tool grants are owned by the portal
-- (PUT /api/permissions/tool-grants is a full replace). A previous version of
-- this migration seeded lowercase 'staff'/'viewer' role grants; because
-- runMigrations() re-runs every file on every service boot, that seed kept
-- re-appearing even after a portal save wiped the table. The seed is removed
-- here and existing seed rows are purged in 0003_remove_legacy_role_seed.sql.

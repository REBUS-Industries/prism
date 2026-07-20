CREATE TABLE IF NOT EXISTS "file_library_project_folders" (
	"project_id" text PRIMARY KEY NOT NULL,
	"project_name" varchar(512),
	"relative_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_library_project_folders_path_idx" ON "file_library_project_folders" USING btree ("relative_path");

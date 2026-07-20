CREATE TABLE IF NOT EXISTS "file_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(512) NOT NULL,
	"normalized_name" varchar(512) NOT NULL,
	"extension" varchar(32) NOT NULL,
	"project_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_version_id" uuid,
	"version_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"original_filename" varchar(512) NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_hash" varchar(64),
	"storage_path" text NOT NULL,
	"source" varchar(32) DEFAULT 'api' NOT NULL,
	"source_app" varchar(64),
	"uploaded_by_label" varchar(256) NOT NULL,
	"created_by_api_key_id" uuid,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_documents_normalized_name_idx" ON "file_documents" USING btree ("normalized_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_documents_project_idx" ON "file_documents" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_versions_document_idx" ON "file_versions" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_versions_document_version_idx" ON "file_versions" USING btree ("document_id","version_number");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_document_id_file_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."file_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_created_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("created_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

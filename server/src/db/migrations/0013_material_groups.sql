CREATE TABLE IF NOT EXISTS "material_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(128) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_groups_sort_order_idx" ON "material_groups" USING btree ("sort_order");
--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "group_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "materials" ADD CONSTRAINT "materials_group_id_material_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."material_groups"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

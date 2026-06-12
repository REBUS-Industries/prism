ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "branched_from_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "materials" ADD CONSTRAINT "materials_branched_from_id_materials_id_fk" FOREIGN KEY ("branched_from_id") REFERENCES "public"."materials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

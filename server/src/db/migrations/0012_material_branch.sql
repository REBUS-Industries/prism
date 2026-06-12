ALTER TABLE "materials" ADD COLUMN "branched_from_id" uuid;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_branched_from_id_materials_id_fk" FOREIGN KEY ("branched_from_id") REFERENCES "public"."materials"("id") ON DELETE set null ON UPDATE no action;

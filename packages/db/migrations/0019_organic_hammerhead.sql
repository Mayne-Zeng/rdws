CREATE TABLE "requirement_delivery_merge" (
	"requirement_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"snapshot_seq" integer NOT NULL,
	"environment" text NOT NULL,
	"cherry_pick_commit" text NOT NULL,
	"merge_commit" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_delivery_merge_requirement_id_repository_id_snapshot_seq_environment_pk" PRIMARY KEY("requirement_id","repository_id","snapshot_seq","environment"),
	CONSTRAINT "requirement_delivery_merge_hashes" CHECK ("requirement_delivery_merge"."cherry_pick_commit" collate "C" ~ '^[0-9a-f]{40}$'
          and ("requirement_delivery_merge"."merge_commit" is null or "requirement_delivery_merge"."merge_commit" collate "C" ~ '^[0-9a-f]{40}$')),
	CONSTRAINT "requirement_delivery_merge_environment" CHECK (char_length("requirement_delivery_merge"."environment") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "requirement_delivery_snapshot" (
	"requirement_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"snapshot_seq" integer NOT NULL,
	"commit_hash" text NOT NULL,
	"parent_head" text NOT NULL,
	"base_commit" text NOT NULL,
	"paths" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"message_sha256" text NOT NULL,
	"command_id" text NOT NULL,
	"committed_by" text NOT NULL,
	"generation" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_delivery_snapshot_requirement_id_repository_id_snapshot_seq_pk" PRIMARY KEY("requirement_id","repository_id","snapshot_seq"),
	CONSTRAINT "requirement_delivery_snapshot_hashes" CHECK ("requirement_delivery_snapshot"."commit_hash" collate "C" ~ '^[0-9a-f]{40}$' and
          "requirement_delivery_snapshot"."parent_head" collate "C" ~ '^[0-9a-f]{40}$' and
          "requirement_delivery_snapshot"."base_commit" collate "C" ~ '^[0-9a-f]{40}$' and
          "requirement_delivery_snapshot"."content_digest" collate "C" ~ '^[a-f0-9]{64}$' and
          "requirement_delivery_snapshot"."message_sha256" collate "C" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "requirement_delivery_snapshot_paths" CHECK (jsonb_typeof("requirement_delivery_snapshot"."paths") = 'array' and jsonb_array_length("requirement_delivery_snapshot"."paths") between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "requirement_delivery_merge" ADD CONSTRAINT "requirement_delivery_merge_snapshot_fk" FOREIGN KEY ("requirement_id","repository_id","snapshot_seq") REFERENCES "public"."requirement_delivery_snapshot"("requirement_id","repository_id","snapshot_seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_delivery_snapshot" ADD CONSTRAINT "requirement_delivery_snapshot_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_delivery_snapshot" ADD CONSTRAINT "requirement_delivery_snapshot_committed_by_auth_user_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_delivery_snapshot_commit_idx" ON "requirement_delivery_snapshot" USING btree ("repository_id","commit_hash");--> statement-breakpoint
CREATE INDEX "requirement_delivery_snapshot_requirement_idx" ON "requirement_delivery_snapshot" USING btree ("requirement_id");
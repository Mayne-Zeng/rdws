CREATE TABLE "capability_approval" (
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"revision" text NOT NULL,
	"approved" boolean NOT NULL,
	CONSTRAINT "capability_approval_kind_reference_revision_pk" PRIMARY KEY("kind","reference","revision"),
	CONSTRAINT "capability_approval_kind" CHECK ("capability_approval"."kind" in ('plugin', 'skill', 'mcp')),
	CONSTRAINT "capability_approval_reference" CHECK (char_length("capability_approval"."reference") <= 160 and "capability_approval"."reference" ~ '^@?[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)+$'),
	CONSTRAINT "capability_approval_revision" CHECK (char_length("capability_approval"."revision") <= 128 and "capability_approval"."revision" ~ '^[A-Za-z0-9][A-Za-z0-9._:+-]*$')
);

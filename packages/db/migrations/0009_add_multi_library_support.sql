-- Hand-written (#84, #144), after Navidrome's 20240511220020_add_library_table
-- and 20250701010108_add_multi_library_support migrations: libraries
-- (ADR-0009). The snapshot is drizzle-kit's, and a regeneration finds no
-- change.
--
-- No table is rebuilt, dropped or copied. D1 enforces foreign keys and cannot
-- turn them off, so a DROP TABLE of `track` or `playlist` would fire the
-- ON DELETE CASCADE of `track_lyrics` and `playlist_track`. Key uniqueness is
-- a named index (migration 0002), so it is swapped in place instead:
--
-- 1. the unique index on `r2_key` is dropped;
-- 2. `library_id` is added with a default of 1, the bound bucket, and no
--    REFERENCES: SQLite refuses a referencing column with a non-null default
--    while foreign keys are on, and these tables keep none anyway;
-- 3. `(library_id, r2_key)` becomes the unique key.
DROP INDEX `track_r2_key_unique`;--> statement-breakpoint
ALTER TABLE `track` ADD `library_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `track_library_id_r2_key_unique` ON `track` (`library_id`,`r2_key`);--> statement-breakpoint
DROP INDEX `playlist_r2_key_unique`;--> statement-breakpoint
ALTER TABLE `playlist` ADD `library_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `playlist_library_id_r2_key_unique` ON `playlist` (`library_id`,`r2_key`);--> statement-breakpoint
-- Albums are per library; artists are shared and get no column.
ALTER TABLE `album` ADD `library_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE TABLE `library` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`endpoint` text,
	`region` text,
	`bucket` text,
	`credentials` text,
	`writable` integer DEFAULT true NOT NULL,
	`default_new_users` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`last_scan_started_at` integer,
	`last_scan_at` integer,
	`last_scan_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_path_unique` ON `library` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_name_unique` ON `library` (lower("name"));--> statement-breakpoint
-- Library 1 is the bucket the Worker binds as MUSIC, named as Navidrome names
-- its default library, and given to new users, as Navidrome gives it.
INSERT INTO `library` (`id`, `name`, `path`, `kind`, `default_new_users`, `created_at`, `updated_at`)
VALUES (1, 'Music Library', 'r2-binding://MUSIC', 'r2-binding', 1, unixepoch() * 1000, unixepoch() * 1000);--> statement-breakpoint
CREATE TABLE `user_library` (
	`user_id` text NOT NULL,
	`library_id` integer NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`),
	FOREIGN KEY (`user_id`) REFERENCES `subsonic_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`library_id`) REFERENCES `library`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_library_library_id_idx` ON `user_library` (`library_id`);--> statement-breakpoint
-- Navidrome's backfill: every existing user, admins too, gets library 1.
INSERT INTO `user_library` (`user_id`, `library_id`) SELECT `id`, 1 FROM `subsonic_user`;

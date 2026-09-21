CREATE TABLE `album` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`artist_id` text NOT NULL,
	`album_artist` text NOT NULL,
	`year` integer,
	`genre` text,
	`song_count` integer DEFAULT 0 NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`cover_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `album_artist_id_idx` ON `album` (`artist_id`);--> statement-breakpoint
CREATE TABLE `annotation` (
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`item_type` text NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`starred_at` integer,
	`rating` integer DEFAULT 0 NOT NULL,
	`play_count` integer DEFAULT 0 NOT NULL,
	`play_date` integer,
	PRIMARY KEY(`user_id`, `item_id`, `item_type`)
);
--> statement-breakpoint
CREATE INDEX `annotation_user_id_item_type_idx` ON `annotation` (`user_id`,`item_type`);--> statement-breakpoint
CREATE TABLE `artist` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playlist` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`owner_id` text NOT NULL,
	`public` integer DEFAULT true NOT NULL,
	`song_count` integer DEFAULT 0 NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `playlist_owner_id_idx` ON `playlist` (`owner_id`);--> statement-breakpoint
CREATE TABLE `playlist_track` (
	`playlist_id` text NOT NULL,
	`track_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`playlist_id`, `position`)
);
--> statement-breakpoint
CREATE INDEX `playlist_track_track_id_idx` ON `playlist_track` (`track_id`);--> statement-breakpoint
CREATE TABLE `track` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`title` text NOT NULL,
	`album_id` text NOT NULL,
	`artist_id` text NOT NULL,
	`artist` text NOT NULL,
	`album_artist` text NOT NULL,
	`track_number` integer,
	`disc_number` integer,
	`year` integer,
	`duration` real DEFAULT 0 NOT NULL,
	`bit_rate` integer DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`suffix` text NOT NULL,
	`genre` text,
	`etag` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `track_r2_key_unique` ON `track` (`r2_key`);--> statement-breakpoint
CREATE INDEX `track_album_id_idx` ON `track` (`album_id`);--> statement-breakpoint
CREATE INDEX `track_artist_id_idx` ON `track` (`artist_id`);
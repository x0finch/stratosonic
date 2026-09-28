CREATE TABLE `track_lyrics` (
	`track_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`lang` text DEFAULT 'xxx' NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `track`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `track` ADD `scan_version` integer DEFAULT 0 NOT NULL;
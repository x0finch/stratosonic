CREATE TABLE `play_queue` (
	`user_id` text PRIMARY KEY NOT NULL,
	`track_ids` text DEFAULT '[]' NOT NULL,
	`current` text,
	`position` integer DEFAULT 0 NOT NULL,
	`changed_by` text DEFAULT '' NOT NULL,
	`changed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

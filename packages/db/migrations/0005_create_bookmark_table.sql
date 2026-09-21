CREATE TABLE `bookmark` (
	`user_id` text NOT NULL,
	`track_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `track_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

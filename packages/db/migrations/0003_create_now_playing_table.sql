CREATE TABLE `now_playing` (
	`user_id` text PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`player_name` text DEFAULT '' NOT NULL,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

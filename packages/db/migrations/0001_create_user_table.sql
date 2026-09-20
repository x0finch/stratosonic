CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`user_name` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`password` text DEFAULT '' NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`token_epoch` integer DEFAULT 0 NOT NULL,
	`last_login_at` integer,
	`last_access_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_user_name_unique` ON `user` (lower("user_name"));
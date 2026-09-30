CREATE TABLE `operator` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_username` text NOT NULL,
	`username` text GENERATED ALWAYS AS (lower("display_username")) VIRTUAL NOT NULL,
	`email` text GENERATED ALWAYS AS (lower("display_username") || '@console.invalid') VIRTUAL NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_username_unique` ON `operator` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `operator_email_unique` ON `operator` (`email`);--> statement-breakpoint
CREATE TABLE `operator_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `operator`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `operator_account_user_id_idx` ON `operator_account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `operator_account_provider_account_unique` ON `operator_account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `operator_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `operator`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_session_token_unique` ON `operator_session` (`token`);--> statement-breakpoint
CREATE INDEX `operator_session_user_id_idx` ON `operator_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `operator_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `operator_verification_identifier_idx` ON `operator_verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);
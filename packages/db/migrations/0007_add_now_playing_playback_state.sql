ALTER TABLE `now_playing` ADD `state` text DEFAULT 'playing' NOT NULL;--> statement-breakpoint
ALTER TABLE `now_playing` ADD `position_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `now_playing` ADD `playback_rate` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `now_playing` ADD `reported_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `now_playing` ADD `expires_at` integer DEFAULT 0 NOT NULL;
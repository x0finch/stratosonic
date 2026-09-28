CREATE TABLE `track_lyrics` (
	`track_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`lang` text DEFAULT 'xxx' NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `track`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Forget every stored etag, once, so the next scan pass reads each track's
-- tags again and stores the lyrics of the tracks indexed before this table
-- existed. Nothing but the scan's change check reads `track.etag`.
UPDATE `track` SET `etag` = '';

CREATE TABLE `conversation_slugs` (
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `slug`, `conversation_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_slugs_lookup` ON `conversation_slugs` (`user_id`,`slug`,`created_at`);--> statement-breakpoint
CREATE INDEX `conversation_slugs_conversation` ON `conversation_slugs` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`title_source` text DEFAULT 'auto' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`thinking` text DEFAULT '' NOT NULL,
	`session_file` text,
	`pinned_at` integer,
	`archived_at` integer,
	`short_id` text,
	`forked_from` text,
	`snippet` text,
	`has_attachments` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_user_updated` ON `conversations` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_user_short` ON `conversations` (`user_id`,`short_id`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`conversation_id` text,
	`text` text DEFAULT '' NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `scope`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `drafts_conversation` ON `drafts` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `mcp_chat_servers` (
	`conversation_id` text NOT NULL,
	`server_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `server_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_credentials` (
	`user_id` text NOT NULL,
	`server_id` text NOT NULL,
	`resource` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`scope` text DEFAULT '' NOT NULL,
	`missing_scope` text,
	`expires_at` integer,
	`status` text DEFAULT 'connected' NOT NULL,
	`account` text,
	`connected_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `server_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_clients` (
	`issuer` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`method` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`issuer`, `redirect_uri`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `uploads_user` ON `uploads` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);

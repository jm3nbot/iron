CREATE TABLE `workspace_items` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`section` text NOT NULL,
	`group_name` text DEFAULT '' NOT NULL,
	`url` text,
	`priority` text DEFAULT 'none' NOT NULL,
	`due_date` text,
	`completed` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`indent` integer DEFAULT 0 NOT NULL,
	`bold` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE TABLE `recipe_cooks` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`recipe_id` text,
	`title` text NOT NULL,
	`cooked_on` text NOT NULL,
	`note` text,
	`user_id` text,
	`source` text NOT NULL,
	`client_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recipe_cooks_date" CHECK("recipe_cooks"."cooked_on" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
	CONSTRAINT "recipe_cooks_note_length" CHECK("recipe_cooks"."note" IS NULL OR length("recipe_cooks"."note") <= 2000),
	CONSTRAINT "recipe_cooks_source" CHECK("recipe_cooks"."source" IN ('web', 'mcp'))
);
--> statement-breakpoint
CREATE INDEX `recipe_cooks_household_date` ON `recipe_cooks` (`household_id`,`cooked_on`);--> statement-breakpoint
CREATE INDEX `recipe_cooks_recipe` ON `recipe_cooks` (`recipe_id`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`body` text,
	`added_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recipes_title_length" CHECK(length("recipes"."title") BETWEEN 1 AND 200),
	CONSTRAINT "recipes_url" CHECK("recipes"."url" IS NULL OR (length("recipes"."url") <= 2000 AND ("recipes"."url" LIKE 'https://%' OR "recipes"."url" LIKE 'http://%'))),
	CONSTRAINT "recipes_body_length" CHECK("recipes"."body" IS NULL OR length("recipes"."body") <= 20000)
);
--> statement-breakpoint
CREATE INDEX `recipes_household_updated` ON `recipes` (`household_id`,`updated_at`);
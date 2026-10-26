CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "books_title_length" CHECK(length("books"."title") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_household_title` ON `books` (`household_id`,`title`);--> statement-breakpoint
CREATE TABLE `recipe_tags` (
	`recipe_id` text NOT NULL,
	`household_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`recipe_id`, `tag`),
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "recipe_tags_tag_length" CHECK(length("recipe_tags"."tag") BETWEEN 1 AND 30)
);
--> statement-breakpoint
CREATE INDEX `recipe_tags_household_tag` ON `recipe_tags` (`household_id`,`tag`);--> statement-breakpoint
ALTER TABLE `recipes` ADD `book_id` text REFERENCES books(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `recipes` ADD `page` text;--> statement-breakpoint
CREATE INDEX `recipes_book` ON `recipes` (`book_id`);
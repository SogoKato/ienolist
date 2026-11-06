-- The scopes become read and write. Connections made with the old ones are dropped; assistants connect again.
DELETE FROM `oauth_codes`;--> statement-breakpoint
DELETE FROM `oauth_tokens`;

// Tags are typed in one field, separated by spaces or commas (also Japanese ones); a leading #
// is dropped, since people write tags that way. The server applies the same rules.
export const parseTags = (text: string) => [...new Set(text.split(/[\s,、，]+/).map((t) => t.replace(/^#+/, "")).filter(Boolean))];

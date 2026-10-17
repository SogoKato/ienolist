// ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32, 26 chars.
// Strings sort by creation time; ids created in the same millisecond order randomly.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  const random = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const byte of random) rand += ALPHABET[byte & 31];
  return time + rand;
}

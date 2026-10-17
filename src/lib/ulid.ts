// ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32, 26 chars.
// Strings sort by creation time. `ulid` alone leaves ids created in the same
// millisecond in random order; `monotonicUlid` keeps them in creation order.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_LENGTH = 16;

const randomDigits = () => crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH)).map((byte) => byte & 31);

function encode(time: number, digits: Uint8Array): string {
  let out = "";
  for (let t = time, i = 0; i < 10; i++, t = Math.floor(t / 32)) out = ALPHABET[t % 32] + out;
  for (const digit of digits) out += ALPHABET[digit];
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encode(now, randomDigits());
}

// A generator whose ids strictly increase, even within one millisecond or when the clock steps back.
export function monotonicUlid(clock: () => number = Date.now, random: () => Uint8Array = randomDigits): () => string {
  let lastTime = -1;
  let digits: Uint8Array = new Uint8Array(RANDOM_LENGTH);
  return () => {
    const now = clock();
    if (now > lastTime) {
      lastTime = now;
      digits = random();
    } else {
      let i = RANDOM_LENGTH - 1;
      while (i >= 0 && digits[i] === 31) digits[i--] = 0;
      if (i >= 0) digits[i]++;
      else {
        // The random part is exhausted for this millisecond: move on to the next one.
        lastTime++;
        digits = random();
      }
    }
    return encode(lastTime, digits);
  };
}

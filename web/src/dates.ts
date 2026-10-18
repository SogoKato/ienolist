// Today in the person's own time zone, YYYY-MM-DD: the day a dish was cooked is a local day.
export function localDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 2026-10-05 -> 10/5, with the year only when it is not this one.
export function shortDate(day: string, today = localDate()): string {
  const [y, m, d] = day.split("-").map(Number);
  return y === Number(today.slice(0, 4)) ? `${m}/${d}` : `${y}/${m}/${d}`;
}

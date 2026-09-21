/** Pure helpers for the clock widget (no DOM, testable in Node). */
export function validZone(tz: string): boolean {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

export function fmtTime(d: Date, hour12: boolean, timeZone?: string, locale?: string): string {
  return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12, timeZone });
}

export function fmtDay(d: Date, timeZone?: string, locale?: string): string {
  return d.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone });
}

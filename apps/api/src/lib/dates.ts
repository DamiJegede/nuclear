/** Program dates are plain YYYY-MM-DD strings (America/New_York calendar days). */
export const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Program day boundary: 00:00 America/New_York. */
export const PROGRAM_TZ = "America/New_York";

/** The program date (America/New_York) of an instant, as YYYY-MM-DD. */
export const easternDate = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: PROGRAM_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

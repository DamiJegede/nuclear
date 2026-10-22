/** Program dates are plain YYYY-MM-DD strings (America/New_York calendar days). */
export const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Keep only what a money field may hold: digits and one decimal point. */
export const decimalOnly = (v: string): string => {
  const c = v.replace(/[^0-9.]/g, "");
  const i = c.indexOf(".");
  return i < 0 ? c : c.slice(0, i + 1) + c.slice(i + 1).replace(/\./g, "");
};
/** Keep only digits (quantities and stock). */
export const digitsOnly = (v: string): string => v.replace(/\D/g, "");

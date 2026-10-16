// Access Tokens are 32 characters: mixed case, digits and a few symbols, no look-alike characters
// (no 0/O, 1/l/I). Generated in the browser with the platform's secure random source.

export const ACCESS_TOKEN_LENGTH = 32;
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGIT = "23456789";
const SYMBOL = "-_.+=";
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

/** An unbiased random index in [0, n): values that would skew the result are thrown away. */
function randomIndex(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

export function generateAccessToken(): string {
  for (;;) {
    let t = "";
    for (let i = 0; i < ACCESS_TOKEN_LENGTH; i++) t += ALL[randomIndex(ALL.length)];
    if ([UPPER, LOWER, DIGIT, SYMBOL].every((set) => [...t].some((c) => set.includes(c)))) return t;
  }
}

/** The text of the downloadable credentials file. */
export function credentialsText(name: string, accessId: string, accessToken: string, portalUrl: string): string {
  return [
    "Nuclear Admin sign-in",
    `Portal:        ${portalUrl}`,
    `Name:          ${name}`,
    `Access ID:     ${accessId}`,
    `Access Token:  ${accessToken}`,
    "",
    "Keep this file private and delete it once you have signed in.",
    "At your first sign-in you must replace this Access Token with your own (32 characters or more)",
    "and set up two-step verification with an authenticator app. This one then stops working.",
    "",
  ].join("\n");
}

/** Offer a text file for download. Returns false when the browser cannot do it. */
export function downloadText(filename: string, text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

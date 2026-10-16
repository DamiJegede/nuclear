// Helpers for the one-time credentials the server issues (Access IDs and Access Tokens are generated server-side).

/** Access IDs are 12 characters and Access Tokens 32, always (the server generates both). */
export const ACCESS_ID_LENGTH = 12;
export const ACCESS_TOKEN_LENGTH = 32;

/** The text of the downloadable credentials file. */
export function credentialsText(name: string, accessId: string, accessToken: string, portalUrl: string): string {
  return [
    "Nuclear Admin sign-in",
    `Portal:        ${portalUrl}`,
    `Name:          ${name}`,
    `Access ID:     ${accessId}`,
    `Access Token:  ${accessToken}`,
    "",
    "Keep this file private. The Access Token cannot be shown again.",
    "At your first sign-in you set up two-step verification with an authenticator app.",
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

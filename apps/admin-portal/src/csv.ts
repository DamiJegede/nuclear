/** Reads a supplier's file (CSV or plain list) and pulls out the NFC UIDs: 14 hex characters, with or without separators. */
export type ParsedUids = { uids: string[]; duplicates: number; ignored: number };

export function parseUids(text: string): ParsedUids {
  const seen = new Set<string>();
  let duplicates = 0;
  let ignored = 0;
  for (const raw of text.split(/[\s,;|]+/)) {
    const token = raw.replace(/^["']+|["']+$/g, "");
    if (!token) continue;
    const uid = token.replace(/[:\-]/g, "").toUpperCase();
    if (/^[0-9A-F]{14}$/.test(uid)) {
      if (seen.has(uid)) duplicates++;
      else seen.add(uid);
    } else {
      ignored++;                       // header cells, labels and anything else that is not a UID
    }
  }
  return { uids: [...seen], duplicates, ignored };
}

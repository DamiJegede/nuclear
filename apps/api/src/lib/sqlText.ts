/** A LIKE pattern that matches `q` anywhere, with the wildcard characters in `q` taken literally. */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

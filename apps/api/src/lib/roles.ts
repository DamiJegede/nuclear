/**
 * Admin roles and the screens each one may use. One place decides this; the API enforces it per route
 * and tells the portal (via /me) which pages to show and where to land after sign-in.
 */
export const ROLES = ["admin", "accounting", "sales", "support", "tags", "merchants"] as const;
export type Role = (typeof ROLES)[number];

export const PAGES = ["overview", "merchants", "users", "tags", "admins", "transactions"] as const;
export type Page = (typeof PAGES)[number];

/** Pages per role. Every role can also open its own Security page (its own two-step verification). */
export const ROLE_PAGES: Record<Role, readonly Page[]> = {
  admin: PAGES,
  accounting: ["overview", "transactions"],
  sales: ["users", "merchants", "tags"],
  support: ["users", "transactions"],
  tags: ["tags"],
  merchants: ["merchants"],
};

/** The page a role lands on after sign-in: its first. */
export const landing = (role: Role): Page => ROLE_PAGES[role][0]!;

/** Roles that may change tags (create, edit, upload images, load UIDs). Sales can see tags, not change them. */
export const TAG_WRITERS: readonly Role[] = ["admin", "tags"];

/** Roles that may take support actions on merchants (sign a terminal out). Sales can look. */
export const MERCHANT_WRITERS: readonly Role[] = ["admin", "merchants"];

/** Roles that may approve or reject a merchant's pending refunds and suspend or reactivate a merchant. */
export const MERCHANT_ADMINS: readonly Role[] = ["admin"];

/** Roles that may take support actions on a person: sign them out everywhere, unlock their login, revoke an agent key. */
export const USER_WRITERS: readonly Role[] = ["admin", "support"];
/** Roles that may suspend or reactivate a person or one of their wallets. */
export const USER_ADMINS: readonly Role[] = ["admin"];

export const canSee = (role: Role, page: Page) => ROLE_PAGES[role].includes(page);
export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

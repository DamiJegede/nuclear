// The roles an admin can have. Which pages each one sees is decided by the API (it tells the portal in
// the sign-in answer and in /me); this file only has the names people read.
export const ROLES = ["admin", "accounting", "sales", "support", "tags", "merchants"] as const;
export type Role = (typeof ROLES)[number];

export type Page = "overview" | "merchants" | "users" | "tags" | "admins" | "transactions";

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin", accounting: "Accounting", sales: "Sales", support: "Support", tags: "Tags", merchants: "Merchants",
};

/** One line for the role picker: what the role can open. */
export const ROLE_SUMMARY: Record<Role, string> = {
  admin: "Everything, including Admins",
  accounting: "Overview and Transactions",
  sales: "Users, Merchants and Tags (Tags read-only)",
  support: "Users and Transactions",
  tags: "Tags only",
  merchants: "Merchants only",
};

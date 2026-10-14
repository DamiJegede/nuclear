import { z } from "zod";

// Reserved so they cannot impersonate the platform. Extend as needed.
const RESERVED = new Set(["admin", "root", "nuclear", "support", "system", "staff", "team", "help", "null", "test"]);

/** 4-12 letters/digits, trimmed and lowercased (stored lowercase, matched case-insensitively). */
export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{4,12}$/, "handle_invalid")
  .refine((h) => !RESERVED.has(h), { message: "handle_reserved" });

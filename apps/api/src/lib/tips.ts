import { z } from "zod";
import { amount } from "./money";
import { uuid } from "./validate";

/** The tip fields of a terminal payment (see docs/TABLES.md, "tips"). `tip` is part of what the payer pays; the rest says who gets it. */
export const tipFields = {
  tip: amount.optional(),
  served_by: uuid.optional(),
  tips: z.array(z.object({ staff_id: uuid, amount })).min(1).max(20).optional(),
};

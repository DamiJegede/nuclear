import type { Context } from "hono";
import type { AppContext } from "../env";
import { signReceipt } from "../crypto";
import { publicBaseUrl } from "./images";

/** The public receipt address for a payment (null when the Worker has no signing secret). Built on the same base as photo addresses. */
export async function receiptUrl(c: Context<AppContext>, payId: string): Promise<string | null> {
  const secret = c.env.JWT_SECRET;
  if (!secret) return null;
  return `${publicBaseUrl()}/v1/receipts/${await signReceipt(secret, payId)}`;
}

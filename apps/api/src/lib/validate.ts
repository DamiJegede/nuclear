import { z } from "zod";

/** The one UUID validator for ids in paths, bodies and queries. */
export const uuid = z.string().uuid();

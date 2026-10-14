import { z } from "zod/v4";

const positiveInteger = (maximum: number) => z.string().regex(/^[1-9][0-9]*$/)
  .transform(Number).pipe(z.number().int().min(1).max(maximum));

export const paginationInput = z.strictObject({
  page: positiveInteger(2147483647).default(1), limit: positiveInteger(100).default(20),
});

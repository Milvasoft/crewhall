import { z } from 'zod';

/** Search params shared by folder pages: viewer, detail panel and view mode. */
export const driveSearch = z.object({
  preview: z.string().optional(),
  detail: z.string().optional(),
  view: z.literal('grid').optional(),
});

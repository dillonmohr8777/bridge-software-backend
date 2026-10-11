import { z } from "zod";

export const businessOrganizationParamsSchema = z.object({
    organizationId: z.uuid()
});

export const createBusinessSchema = z
    .object({
        legalName: z.string().trim().min(1).max(200),
        dbaName: z.string().trim().min(1).max(200).nullable().optional()
    })
    .strict();

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

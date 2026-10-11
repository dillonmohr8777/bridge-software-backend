import { z } from "zod";

export const contactRequestTargetParamsSchema = z.object({
    slug: z.string().trim().min(3).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
});

export const organizationContactRequestParamsSchema = z.object({
    organizationId: z.uuid(),
    requestId: z.uuid().optional()
});

export const createContactRequestSchema = z.object({
    firstName: z.string().trim().min(1).max(100),
    workEmail: z.email().trim().max(320),
    phoneNumber: z.string().trim().min(7).max(32).regex(/^\+?[0-9 ()-]+$/),
    yearsOfService: z.number().int().min(0).max(80),
    contactPreference: z.enum(["email", "phone", "either"]),
    message: z.string().trim().max(2000).nullable().optional()
}).strict();

export const contactRequestListQuerySchema = z.object({
    status: z.enum(["new", "viewed", "responded", "closed"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10000).default(0)
}).strict();

export const sentContactRequestListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10000).default(0)
}).strict();

export const contactRequestTransitionSchema = z.object({
    status: z.enum(["viewed", "responded", "closed"])
}).strict();

export type CreateContactRequestInput = z.infer<typeof createContactRequestSchema>;
export type ContactRequestListQuery = z.infer<typeof contactRequestListQuerySchema>;
export type SentContactRequestListQuery = z.infer<typeof sentContactRequestListQuerySchema>;
export type ContactRequestTransitionInput = z.infer<typeof contactRequestTransitionSchema>;

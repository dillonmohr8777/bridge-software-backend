import { z } from "zod";

const optionalQueryValue = <T extends z.ZodType>(schema: T) =>
    z.preprocess(
        (value) => (value === "" ? undefined : value),
        schema.optional()
    );

export const adminUsersQuerySchema = z
    .object({
        page: optionalQueryValue(z.coerce.number().int().min(1)).default(1),
        pageSize: optionalQueryValue(
            z.coerce.number().int().min(1).max(100)
        ).default(50)
    })
    .strict();

export const adminUserInvitationSchema = z
    .object({
        email: z.string().trim().toLowerCase().email().max(254),
        displayName: z.string().trim().min(1).max(100),
        accountType: z.enum(["standard", "sales_rep"]).default("standard"),
        platformRole: z.literal("admin").nullable().optional()
    })
    .strict();

export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;
export type AdminUserInvitationInput = z.infer<
    typeof adminUserInvitationSchema
>;

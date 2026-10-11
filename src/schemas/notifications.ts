import { z } from "zod";

export const notificationListQuerySchema = z.object({
    unreadOnly: z.enum(["true", "false"]).transform((v) => v === "true").default(false),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10000).default(0)
}).strict();
export const notificationParamsSchema = z.object({ notificationId: z.uuid() });
export const notificationPreferencesSchema = z.object({
    profile: z.object({ inApp: z.boolean(), email: z.boolean() }).strict(),
    contact: z.object({ inApp: z.boolean(), email: z.boolean() }).strict(),
    verification: z.object({ inApp: z.boolean(), email: z.boolean() }).strict()
}).strict();
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

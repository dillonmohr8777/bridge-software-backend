import { z } from "zod";
export const directoryRequestKind = z.enum(["contact", "claim", "correction"]);
export const createDirectoryRequestSchema = z.object({
    profileId: z.uuid(), kind: directoryRequestKind, message: z.string().trim().min(1).max(5000),
    shareEmail: z.boolean().default(false), idempotencyKey: z.uuid()
}).strict();
export const reviewDirectoryRequestSchema = z.object({ status: z.enum(["resolved", "rejected"]) }).strict();
export const directoryRequestIdSchema = z.object({ id: z.uuid() });
export const directoryRequestsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    kind: directoryRequestKind.optional(), status: z.enum(["pending", "resolved", "rejected"]).optional()
}).strict();
export type CreateDirectoryRequest = z.infer<typeof createDirectoryRequestSchema>;
export type DirectoryRequestsQuery = z.infer<typeof directoryRequestsQuerySchema>;

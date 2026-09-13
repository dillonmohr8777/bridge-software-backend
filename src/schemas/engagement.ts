import { z } from "zod";

export const engagementPageSchema = z.object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20)
}).strict();
export const postsQuerySchema = engagementPageSchema.extend({ profileId: z.uuid().optional() });
export const engagementIdSchema = z.object({ id: z.uuid() });
const postFields = z.object({
    type: z.enum(["announcement", "news"]),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10000),
    status: z.enum(["draft", "published"])
});
export const createPostSchema = postFields.extend({ profileId: z.uuid(), status: postFields.shape.status.default("draft") }).strict();
export const updatePostSchema = postFields.partial().strict().refine(value => Object.keys(value).length > 0, "An editable field is required.");
export const markReadSchema = z.object({ read: z.literal(true) }).strict();
export type EngagementPage = z.infer<typeof engagementPageSchema>;
export type PostsQuery = z.infer<typeof postsQuerySchema>;
export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;

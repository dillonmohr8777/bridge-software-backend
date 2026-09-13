import { z } from "zod";

const state = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const textList = z.array(z.string().trim().min(1).max(100)).max(30);
const slug = z.string().trim().min(3).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).refine(value => value !== "mine" && !z.uuid().safeParse(value).success, "Reserved slug.");
const editable = z.object({
    slug,
    name: z.string().trim().min(1).max(200),
    companyName: z.string().trim().max(200),
    description: z.string().trim().max(5000),
    location: z.string().trim().max(200),
    state: state.or(z.literal("")),
    serviceTerritories: z.array(state).max(60),
    products: textList,
    categories: textList,
    logoUrl: z.url().max(2048).refine(value => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
    }, "Use an HTTPS URL without credentials.").nullable(),
    visibility: z.enum(["private", "public"])
});
export const createDirectorySchema = editable.extend({
    organizationId: z.uuid().optional(),
    companyName: editable.shape.companyName.default(""),
    description: editable.shape.description.default(""),
    location: editable.shape.location.default(""),
    state: editable.shape.state.default(""),
    serviceTerritories: editable.shape.serviceTerritories.default([]),
    products: textList.default([]),
    categories: textList.default([]),
    logoUrl: editable.shape.logoUrl.default(null),
    visibility: editable.shape.visibility.default("private")
}).strict();
export const updateDirectorySchema = editable.partial().strict().refine(value => Object.keys(value).length > 0, "At least one editable field is required.");
export const directoryQuerySchema = z.object({
    query: z.string().trim().max(100).default(""),
    role: z.enum(["brand", "retailer", "dispensary", "sales_rep"]).optional(),
    state: state.optional(),
    territory: state.optional(),
    category: z.string().trim().min(1).max(100).optional(),
    product: z.string().trim().min(1).max(100).optional(),
    verified: z.enum(["true", "false"]).transform(value => value === "true").optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(24)
}).strict();
export const directoryIdentifierSchema = z.object({ identifier: z.uuid().or(slug) });
export const directoryIdSchema = z.object({ id: z.uuid() });
export type CreateDirectoryInput = z.infer<typeof createDirectorySchema>;
export type UpdateDirectoryInput = z.infer<typeof updateDirectorySchema>;
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;



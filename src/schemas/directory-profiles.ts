import { z } from "zod";

const slugSchema = z
    .string()
    .trim()
    .min(3)
    .max(100)
    .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Slug must contain lowercase letters, numbers, and single hyphens only."
    );

const websiteUrlSchema = z
    .string()
    .trim()
    .max(2048)
    .url()
    .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
    }, "Website URL must use HTTP or HTTPS.");

const nullablePublicEmailSchema = z.union([
    z.email().trim().max(320),
    z.null()
]).optional();

const nullablePublicPhoneSchema = z.union([
    z.string().trim().min(7).max(32).regex(/^\+?[0-9 ()-]+$/),
    z.null()
]).optional();

export const directoryProfileLinkSchema = z.object({
    type: z.enum(["website", "menu", "product", "other"]),
    label: z.string().trim().min(1).max(100),
    url: websiteUrlSchema,
    sortOrder: z.number().int().min(0).max(1000)
}).strict();

export const directoryProfileOrganizationParamsSchema = z.object({
    organizationId: z.uuid()
});

export const publicDirectoryProfileParamsSchema = z.object({
    slug: slugSchema
});

export const publicDirectoryProfilesQuerySchema = z
    .object({
        q: z.string().trim().max(100).optional(),
        organizationType: z
            .enum(["brand", "retailer", "dispensary"])
            .optional(),
        category: z.string().trim().min(1).max(100).optional(),
        state: z.string().trim().min(1).max(100).optional(),
        city: z.string().trim().min(1).max(100).optional(),
        region: z.string().trim().min(1).max(100).optional(),
        verified: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
        sort: z.enum(["name_asc", "name_desc"]).default("name_asc"),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: z.string().trim().min(1).max(1000).optional()
    })
    .strict();

export const directoryProfileAdminParamsSchema = z.object({
    profileId: z.uuid()
});

export const adminDirectoryProfilesQuerySchema = z.object({
    status: z.enum([
        "draft", "pending_review", "correction_requested", "approved",
        "rejected", "suspended"
    ]).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10000).default(0)
}).strict();

export const directoryProfileReviewReasonSchema = z
    .object({
        reason: z.string().trim().min(1).max(2000)
    })
    .strict();

export const directoryProfileLogoUploadSchema = z
    .object({
        contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        fileSize: z.number().int().min(1).max(2 * 1024 * 1024)
    })
    .strict();

export const directoryProfileLogoCompleteSchema = z.object({
    uploadId: z.uuid()
}).strict();

export const directoryProfileContactRoutingSchema = z.object({
    salesRepresentativeMembershipId: z.uuid().nullable(),
    bridgeAdminUserId: z.uuid().nullable()
}).strict();

export const putDirectoryProfileSchema = z
    .object({
        businessId: z.uuid(),
        slug: slugSchema,
        displayName: z.string().trim().min(1).max(200),
        summary: z.string().trim().max(1000).nullable().optional(),
        story: z.string().trim().max(5000).nullable().optional(),
        businessType: z.enum(["brand", "retailer", "dispensary"]),
        categories: z.array(z.string().trim().min(1).max(100)).max(20),
        city: z.string().trim().min(1).max(100).nullable().optional(),
        state: z.string().trim().min(1).max(100).nullable().optional(),
        region: z.string().trim().min(1).max(100).nullable().optional(),
        publicEmail: nullablePublicEmailSchema,
        publicPhone: nullablePublicPhoneSchema,
        licenseType: z.string().trim().min(1).max(100).nullable().optional(),
        licenseNumber: z.string().trim().min(1).max(200).nullable().optional(),
        links: z.array(directoryProfileLinkSchema).max(20)
    })
    .strict();

export type PutDirectoryProfileInput = z.infer<
    typeof putDirectoryProfileSchema
>;
export type DirectoryProfileReviewReasonInput = z.infer<
    typeof directoryProfileReviewReasonSchema
>;
export type PublicDirectoryProfilesQuery = z.infer<
    typeof publicDirectoryProfilesQuerySchema
>;
export type DirectoryProfileLogoUploadInput = z.infer<
    typeof directoryProfileLogoUploadSchema
>;
export type DirectoryProfileLogoCompleteInput = z.infer<typeof directoryProfileLogoCompleteSchema>;
export type DirectoryProfileContactRoutingInput = z.infer<typeof directoryProfileContactRoutingSchema>;
export type AdminDirectoryProfilesQuery = z.infer<typeof adminDirectoryProfilesQuerySchema>;

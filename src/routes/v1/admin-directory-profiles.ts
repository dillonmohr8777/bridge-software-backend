import { Router, type RequestHandler } from "express";

import { loadApplicationIdentity } from "../../middleware/application-identity.js";
import { requireAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/authorization.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validation.js";
import {
    adminDirectoryProfilesQuerySchema,
    directoryProfileAdminParamsSchema,
    directoryProfileReviewReasonSchema,
    type DirectoryProfileReviewReasonInput,
    type AdminDirectoryProfilesQuery
} from "../../schemas/directory-profiles.js";
import {
    reviewDirectoryProfile,
    listAdminDirectoryProfiles,
    type DirectoryProfileReviewAction
} from "../../services/directory-profiles.js";

const router = Router();

export const createListAdminDirectoryProfilesHandler = (
    service: typeof listAdminDirectoryProfiles = listAdminDirectoryProfiles
): RequestHandler => async (_req, res) => {
    try {
        res.status(200).json(await service(res.locals.validatedQuery as AdminDirectoryProfilesQuery));
    } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "INTERNAL_SERVER_ERROR";
        res.status(code === "DIRECTORY_PROFILE_REVIEW_UNAVAILABLE" ? 503 : 500).json({
            error: code, message: "The Directory profile queue could not be loaded."
        });
    }
};

router.get(
    "/directory-profiles",
    requireAuthentication, loadApplicationIdentity,
    requirePermission("admin:directory_review"),
    validateQuery(adminDirectoryProfilesQuerySchema),
    createListAdminDirectoryProfilesHandler()
);

export const createAdminDirectoryReviewHandler = (
    action: DirectoryProfileReviewAction,
    service: typeof reviewDirectoryProfile = reviewDirectoryProfile
): RequestHandler => async (req, res) => {
    const authentication = req.authentication;
    if (!authentication) {
        res.status(401).json({
            error: "UNAUTHORIZED",
            message: "A valid authentication credential is required."
        });
        return;
    }

    try {
        const review = await service(
            authentication.user.id,
            req.params.profileId as string,
            action,
            action === "approve"
                ? undefined
                : req.body as DirectoryProfileReviewReasonInput
        );
        res.status(200).json({ review });
    } catch (error) {
        const code = error instanceof Error && "code" in error
            ? String(error.code)
            : "INTERNAL_SERVER_ERROR";
        const statusByCode: Record<string, number> = {
            DIRECTORY_PROFILE_NOT_FOUND: 404,
            DIRECTORY_PROFILE_INVALID_STATE: 409,
            DIRECTORY_PROFILE_VERIFICATION_REQUIRED: 409,
            DIRECTORY_PROFILE_SELF_REVIEW_FORBIDDEN: 403,
            DIRECTORY_PROFILE_SLUG_CONFLICT: 409,
            DIRECTORY_PROFILE_REVIEW_UNAVAILABLE: 503,
            INTERNAL_SERVER_ERROR: 500
        };
        res.status(statusByCode[code] ?? 500).json({
            error: code,
            message: code === "DIRECTORY_PROFILE_NOT_FOUND"
                ? "Directory profile not found."
                : code === "DIRECTORY_PROFILE_VERIFICATION_REQUIRED"
                    ? "Directory publication eligibility is not satisfied."
                    : code === "DIRECTORY_PROFILE_SELF_REVIEW_FORBIDDEN"
                        ? "An organization member cannot approve their own profile."
                        : code === "DIRECTORY_PROFILE_SLUG_CONFLICT"
                            ? "The published profile slug is already in use."
                            : code === "DIRECTORY_PROFILE_INVALID_STATE"
                                ? "The Directory profile cannot transition from its current status."
                                : "The Directory profile review could not be completed."
        });
    }
};

const protectedReviewMiddleware = [
    requireAuthentication,
    loadApplicationIdentity,
    requirePermission("admin:directory_review"),
    validateParams(directoryProfileAdminParamsSchema)
] as const;

router.post(
    "/directory-profiles/:profileId/approve",
    ...protectedReviewMiddleware,
    createAdminDirectoryReviewHandler("approve")
);

for (const [path, action] of [
    ["request-correction", "request_correction"],
    ["reject", "reject"],
    ["suspend", "suspend"]
] as const) {
    router.post(
        `/directory-profiles/:profileId/${path}`,
        ...protectedReviewMiddleware,
        validateBody(directoryProfileReviewReasonSchema),
        createAdminDirectoryReviewHandler(action)
    );
}

export { router as adminDirectoryProfilesRouter };

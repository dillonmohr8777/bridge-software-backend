import { Router, type RequestHandler, type Response } from "express";

import { loadApplicationIdentity } from "../../middleware/application-identity.js";
import { requireAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/authorization.js";
import {
    validateBody,
    validateParams,
    validateQuery
} from "../../middleware/validation.js";
import {
    directoryProfileLogoUploadSchema,
    directoryProfileLogoCompleteSchema,
    directoryProfileContactRoutingSchema,
    directoryProfileOrganizationParamsSchema,
    publicDirectoryProfilesQuerySchema,
    publicDirectoryProfileParamsSchema,
    putDirectoryProfileSchema,
    type DirectoryProfileLogoUploadInput,
    type DirectoryProfileLogoCompleteInput,
    type DirectoryProfileContactRoutingInput,
    type PublicDirectoryProfilesQuery,
    type PutDirectoryProfileInput
} from "../../schemas/directory-profiles.js";
import {
    createDirectoryProfileLogoUpload,
    completeDirectoryProfileLogoUpload,
    deleteDirectoryProfileLogo,
    DirectoryProfileServiceError,
    getDirectoryProfile,
    getProtectedDirectoryProfileLogoUrl,
    getPublicDirectoryProfileLogoUrl,
    listPublicDirectoryProfiles,
    getPublicDirectoryProfile,
    putDirectoryProfile,
    submitDirectoryProfile,
    getDirectoryProfileContactRouting,
    putDirectoryProfileContactRouting
} from "../../services/directory-profiles.js";

const router = Router();
const organizationIdFromParams = (req: {
    params: { organizationId?: string };
}) => req.params.organizationId;

const sendDirectoryProfileError = (res: Response, error: unknown): void => {
    if (!(error instanceof DirectoryProfileServiceError)) {
        res.status(500).json({
            error: "INTERNAL_SERVER_ERROR",
            message: "An unexpected error occurred."
        });
        return;
    }

    const statusByCode: Record<DirectoryProfileServiceError["code"], number> = {
        DIRECTORY_PROFILE_NOT_FOUND: 404,
        DIRECTORY_PROFILE_BUSINESS_MISMATCH: 400,
        DIRECTORY_PROFILE_BUSINESS_CHANGE_REQUIRES_REAPPROVAL: 409,
        DIRECTORY_PROFILE_SLUG_CONFLICT: 409,
        DIRECTORY_PROFILE_INVALID_STATE: 409,
        DIRECTORY_PROFILE_VERIFICATION_REQUIRED: 409,
        DIRECTORY_PROFILE_SELF_REVIEW_FORBIDDEN: 403,
        DIRECTORY_PROFILE_REVIEW_UNAVAILABLE: 503,
        DIRECTORY_PROFILE_INVALID_CURSOR: 400,
        DIRECTORY_PROFILE_MEDIA_UNAVAILABLE: 503,
        DIRECTORY_PROFILE_READ_FAILED: 500,
        DIRECTORY_PROFILE_WRITE_FAILED: 500,
        INTERNAL_SERVER_ERROR: 500
    };

    const publicMessage = error.code === "DIRECTORY_PROFILE_NOT_FOUND"
        ? "Directory profile not found."
        : error.code === "DIRECTORY_PROFILE_BUSINESS_MISMATCH"
            ? "The selected business does not belong to this organization."
            : error.code === "DIRECTORY_PROFILE_BUSINESS_CHANGE_REQUIRES_REAPPROVAL"
                ? "The business association cannot be changed after approval."
                : error.code === "DIRECTORY_PROFILE_SLUG_CONFLICT"
                    ? "That profile slug is already in use."
                    : error.code === "DIRECTORY_PROFILE_INVALID_STATE"
                        ? "The Directory profile cannot transition from its current status."
                        : error.code === "DIRECTORY_PROFILE_VERIFICATION_REQUIRED"
                            ? "Directory publication eligibility is not satisfied."
                            : error.code === "DIRECTORY_PROFILE_SELF_REVIEW_FORBIDDEN"
                                ? "An organization member cannot approve their own profile."
                    : "The directory profile request could not be completed.";

    res.status(statusByCode[error.code]).json({
        error: error.code,
        message: publicMessage
    });
};

export const createGetDirectoryProfileHandler = (
    service: typeof getDirectoryProfile = getDirectoryProfile
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
        const profile = await service(
            authentication.accessToken,
            req.params.organizationId as string
        );
        res.status(200).json({ profile });
    } catch (error) {
        sendDirectoryProfileError(res, error);
    }
};

export const createPutDirectoryProfileHandler = (
    service: typeof putDirectoryProfile = putDirectoryProfile
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
        const profile = await service(
            authentication.accessToken,
            req.params.organizationId as string,
            req.body as PutDirectoryProfileInput
        );
        res.status(200).json({ profile });
    } catch (error) {
        sendDirectoryProfileError(res, error);
    }
};

export const createGetPublicDirectoryProfileHandler = (
    service: typeof getPublicDirectoryProfile = getPublicDirectoryProfile
): RequestHandler => async (req, res) => {
    try {
        const profile = await service(req.params.slug as string);
        res.status(200).json({ profile });
    } catch (error) {
        sendDirectoryProfileError(res, error);
    }
};

export const createListPublicDirectoryProfilesHandler = (
    service: typeof listPublicDirectoryProfiles = listPublicDirectoryProfiles
): RequestHandler => async (_req, res) => {
    try {
        const result = await service(
            res.locals.validatedQuery as PublicDirectoryProfilesQuery
        );
        res.status(200).json(result);
    } catch (error) {
        sendDirectoryProfileError(res, error);
    }
};

export const createSubmitDirectoryProfileHandler = (
    service: typeof submitDirectoryProfile = submitDirectoryProfile
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
        const profile = await service(
            authentication.accessToken,
            req.params.organizationId as string
        );
        res.status(200).json({ profile });
    } catch (error) {
        sendDirectoryProfileError(res, error);
    }
};

export const createDirectoryProfileLogoUploadHandler = (
    service: typeof createDirectoryProfileLogoUpload = createDirectoryProfileLogoUpload
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
        const upload = await service(
            authentication.accessToken,
            req.params.organizationId as string,
            req.body as DirectoryProfileLogoUploadInput
        );
        res.status(201).json({ upload });
    } catch (error) {
        sendDirectoryProfileError(res, error);
    }
};

export const createDirectoryProfileLogoCompleteHandler = (
    service: typeof completeDirectoryProfileLogoUpload = completeDirectoryProfileLogoUpload
): RequestHandler => async (req, res) => {
    if (!req.authentication) {
        res.status(401).json({ error: "UNAUTHORIZED", message: "A valid authentication credential is required." });
        return;
    }
    try {
        const profile = await service(req.authentication.accessToken, req.params.organizationId as string,
            req.body as DirectoryProfileLogoCompleteInput);
        res.status(200).json({ profile });
    } catch (error) { sendDirectoryProfileError(res, error); }
};

export const createGetDirectoryProfileContactRoutingHandler = (
    service: typeof getDirectoryProfileContactRouting = getDirectoryProfileContactRouting
): RequestHandler => async (req, res) => {
    try {
        const routing = await service(req.authentication?.accessToken ?? "", req.params.organizationId as string);
        res.status(200).json({ routing });
    } catch (error) { sendDirectoryProfileError(res, error); }
};

export const createPutDirectoryProfileContactRoutingHandler = (
    service: typeof putDirectoryProfileContactRouting = putDirectoryProfileContactRouting
): RequestHandler => async (req, res) => {
    try {
        const routing = await service(req.authentication?.accessToken ?? "", req.params.organizationId as string,
            req.body as DirectoryProfileContactRoutingInput);
        res.status(200).json({ routing });
    } catch (error) { sendDirectoryProfileError(res, error); }
};

export const createDeleteDirectoryProfileLogoHandler = (
    service: typeof deleteDirectoryProfileLogo = deleteDirectoryProfileLogo
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
        const profile = await service(
            authentication.accessToken,
            req.params.organizationId as string
        );
        res.status(200).json({ profile });
    } catch (error) {
        sendDirectoryProfileError(res, error);
    }
};

const createPublicLogoRedirectHandler = (
    service: typeof getPublicDirectoryProfileLogoUrl = getPublicDirectoryProfileLogoUrl
): RequestHandler => async (req, res) => {
    try {
        res.redirect(302, await service(req.params.slug as string));
    } catch (error) {
        sendDirectoryProfileError(res, error);
    }
};

const createProtectedLogoRedirectHandler = (
    service: typeof getProtectedDirectoryProfileLogoUrl = getProtectedDirectoryProfileLogoUrl
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
        res.redirect(302, await service(
            authentication.accessToken,
            req.params.organizationId as string
        ));
    } catch (error) {
        sendDirectoryProfileError(res, error);
    }
};

router.get(
    "/organizations/:organizationId/directory-profile",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(directoryProfileOrganizationParamsSchema),
    requirePermission("business:read", organizationIdFromParams),
    createGetDirectoryProfileHandler()
);

router.put(
    "/organizations/:organizationId/directory-profile",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(directoryProfileOrganizationParamsSchema),
    requirePermission("directory_profile:content_update", organizationIdFromParams),
    validateBody(putDirectoryProfileSchema),
    createPutDirectoryProfileHandler()
);

router.post(
    "/organizations/:organizationId/directory-profile/submit",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(directoryProfileOrganizationParamsSchema),
    requirePermission("business:update", organizationIdFromParams),
    createSubmitDirectoryProfileHandler()
);

router.post(
    "/organizations/:organizationId/directory-profile/logo/complete",
    requireAuthentication, loadApplicationIdentity,
    validateParams(directoryProfileOrganizationParamsSchema),
    requirePermission("directory_profile:content_update", organizationIdFromParams),
    validateBody(directoryProfileLogoCompleteSchema),
    createDirectoryProfileLogoCompleteHandler()
);

router.post(
    "/organizations/:organizationId/directory-profile/logo/upload",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(directoryProfileOrganizationParamsSchema),
    requirePermission("directory_profile:content_update", organizationIdFromParams),
    validateBody(directoryProfileLogoUploadSchema),
    createDirectoryProfileLogoUploadHandler()
);

router.get(
    "/organizations/:organizationId/directory-profile/contact-routing",
    requireAuthentication, loadApplicationIdentity,
    validateParams(directoryProfileOrganizationParamsSchema),
    requirePermission("business:update", organizationIdFromParams),
    createGetDirectoryProfileContactRoutingHandler()
);

router.put(
    "/organizations/:organizationId/directory-profile/contact-routing",
    requireAuthentication, loadApplicationIdentity,
    validateParams(directoryProfileOrganizationParamsSchema),
    requirePermission("business:update", organizationIdFromParams),
    validateBody(directoryProfileContactRoutingSchema),
    createPutDirectoryProfileContactRoutingHandler()
);

router.delete(
    "/organizations/:organizationId/directory-profile/logo",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(directoryProfileOrganizationParamsSchema),
    requirePermission("directory_profile:content_update", organizationIdFromParams),
    createDeleteDirectoryProfileLogoHandler()
);

router.get(
    "/organizations/:organizationId/directory-profile/logo",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(directoryProfileOrganizationParamsSchema),
    requirePermission("business:read", organizationIdFromParams),
    createProtectedLogoRedirectHandler()
);

router.get(
    "/directory/profiles",
    validateQuery(publicDirectoryProfilesQuerySchema),
    createListPublicDirectoryProfilesHandler()
);

router.get(
    "/directory/profiles/:slug",
    validateParams(publicDirectoryProfileParamsSchema),
    createGetPublicDirectoryProfileHandler()
);

router.get(
    "/directory/profiles/:slug/logo",
    validateParams(publicDirectoryProfileParamsSchema),
    createPublicLogoRedirectHandler()
);

export { router as directoryProfilesRouter };

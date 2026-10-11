import { Router, type RequestHandler, type Response } from "express";

import { loadApplicationIdentity } from "../../middleware/application-identity.js";
import { requireAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/authorization.js";
import { validateBody, validateParams } from "../../middleware/validation.js";
import {
    businessOrganizationParamsSchema,
    createBusinessSchema,
    type CreateBusinessInput
} from "../../schemas/businesses.js";
import {
    BusinessServiceError,
    createBusiness,
    listBusinesses
} from "../../services/businesses.js";

const router = Router();
const organizationIdFromParams = (req: {
    params: { organizationId?: string };
}) => req.params.organizationId;

const sendBusinessError = (res: Response, error: unknown): void => {
    if (error instanceof BusinessServiceError) {
        res.status(500).json({
            error: error.code,
            message: "The business request could not be completed."
        });
        return;
    }

    res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred."
    });
};

export const createListBusinessesHandler = (
    service: typeof listBusinesses = listBusinesses
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
        const businesses = await service(
            authentication.accessToken,
            req.params.organizationId as string
        );
        res.status(200).json({ businesses });
    } catch (error) {
        sendBusinessError(res, error);
    }
};

export const createCreateBusinessHandler = (
    service: typeof createBusiness = createBusiness
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
        const business = await service(
            authentication.accessToken,
            req.params.organizationId as string,
            req.body as CreateBusinessInput
        );
        res.status(201).json({ business });
    } catch (error) {
        sendBusinessError(res, error);
    }
};

router.get(
    "/organizations/:organizationId/businesses",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(businessOrganizationParamsSchema),
    requirePermission("business:read", organizationIdFromParams),
    createListBusinessesHandler()
);

router.post(
    "/organizations/:organizationId/businesses",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(businessOrganizationParamsSchema),
    requirePermission("business:update", organizationIdFromParams),
    validateBody(createBusinessSchema),
    createCreateBusinessHandler()
);

export { router as businessesRouter };

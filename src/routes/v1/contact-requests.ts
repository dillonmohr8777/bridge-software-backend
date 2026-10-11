import { Router, type RequestHandler, type Response } from "express";

import { loadApplicationIdentity } from "../../middleware/application-identity.js";
import { requireAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/authorization.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validation.js";
import {
    contactRequestListQuerySchema,
    contactRequestTargetParamsSchema,
    contactRequestTransitionSchema,
    createContactRequestSchema,
    organizationContactRequestParamsSchema,
    sentContactRequestListQuerySchema,
    type ContactRequestListQuery,
    type ContactRequestTransitionInput,
    type CreateContactRequestInput,
    type SentContactRequestListQuery
} from "../../schemas/contact-requests.js";
import {
    ContactRequestServiceError,
    createContactRequest,
    listInboundContactRequests,
    listSentContactRequests,
    transitionContactRequest
} from "../../services/contact-requests.js";

const router = Router();
const organizationIdFromParams = (req: { params: { organizationId?: string } }) =>
    req.params.organizationId;

const sendError = (res: Response, error: unknown): void => {
    if (!(error instanceof ContactRequestServiceError)) {
        res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred." });
        return;
    }
    const statuses: Record<ContactRequestServiceError["code"], number> = {
        CONTACT_REQUEST_NOT_FOUND: 404,
        CONTACT_REQUEST_INELIGIBLE: 403,
        CONTACT_REQUEST_INVALID_TRANSITION: 409,
        CONTACT_REQUEST_FAILED: 500
    };
    res.status(statuses[error.code]).json({
        error: error.code,
        message: error.code === "CONTACT_REQUEST_NOT_FOUND"
            ? "Contact request or contactable profile not found."
            : error.code === "CONTACT_REQUEST_INELIGIBLE"
                ? "Contact request eligibility is not satisfied."
                : error.code === "CONTACT_REQUEST_INVALID_TRANSITION"
                    ? "The requested status transition is not allowed."
                    : "The contact request could not be completed."
    });
};

export const createContactRequestHandler = (
    service: typeof createContactRequest = createContactRequest
): RequestHandler => async (req, res) => {
    if (!req.authentication) {
        res.status(401).json({
            error: "UNAUTHORIZED",
            message: "A valid authentication credential is required."
        });
        return;
    }
    try {
        const result = await service(
            req.authentication.accessToken,
            req.params.slug as string,
            req.body as CreateContactRequestInput
        );
        res.status(201).json(result);
    } catch (error) { sendError(res, error); }
};

export const createInboundContactRequestsHandler = (
    service: typeof listInboundContactRequests = listInboundContactRequests
): RequestHandler => async (req, res) => {
    try {
        res.status(200).json(await service(
            req.authentication?.accessToken ?? "",
            req.params.organizationId as string,
            res.locals.validatedQuery as ContactRequestListQuery
        ));
    } catch (error) { sendError(res, error); }
};

export const createSentContactRequestsHandler = (
    service: typeof listSentContactRequests = listSentContactRequests
): RequestHandler => async (req, res) => {
    try {
        res.status(200).json(await service(
            req.authentication?.accessToken ?? "",
            res.locals.validatedQuery as SentContactRequestListQuery
        ));
    } catch (error) { sendError(res, error); }
};

export const createTransitionContactRequestHandler = (
    service: typeof transitionContactRequest = transitionContactRequest
): RequestHandler => async (req, res) => {
    try {
        res.status(200).json(await service(
            req.authentication?.accessToken ?? "",
            req.params.organizationId as string,
            req.params.requestId as string,
            req.body as ContactRequestTransitionInput
        ));
    } catch (error) { sendError(res, error); }
};

router.post(
    "/directory/profiles/:slug/contact-requests",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(contactRequestTargetParamsSchema),
    validateBody(createContactRequestSchema),
    createContactRequestHandler()
);

router.get(
    "/organizations/:organizationId/contact-requests",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(organizationContactRequestParamsSchema),
    requirePermission("contact_request:read", organizationIdFromParams),
    validateQuery(contactRequestListQuerySchema),
    createInboundContactRequestsHandler()
);

router.post(
    "/organizations/:organizationId/contact-requests/:requestId/status",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(organizationContactRequestParamsSchema),
    requirePermission("contact_request:update", organizationIdFromParams),
    validateBody(contactRequestTransitionSchema),
    createTransitionContactRequestHandler()
);

router.get(
    "/contact-requests/sent",
    requireAuthentication,
    loadApplicationIdentity,
    validateQuery(sentContactRequestListQuerySchema),
    createSentContactRequestsHandler()
);

export { router as contactRequestsRouter };

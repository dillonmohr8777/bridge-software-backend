import { Router, type Response } from "express";

import { loadApplicationIdentity } from "../../middleware/application-identity.js";
import { requireAuthentication } from "../../middleware/authentication.js";
import {
    requirePermission
} from "../../middleware/authorization.js";
import {
    validateBody,
    validateParams
} from "../../middleware/validation.js";
import {
    einIntakeParamsSchema,
    einIntakeSchema,
    einAttemptAbandonSchema,
    einAttemptParamsSchema,
    einRevealParamsSchema,
    einVerificationParamsSchema,
    type EinAttemptAbandonInput,
    type EinIntakeInput
} from "../../schemas/ein.js";
import {
    abandonEinVerification,
    EinServiceError,
    intakeEin,
    revealEin,
    verifyEin
} from "../../services/ein.js";

const router = Router();

const organizationIdFromParams = (req: {
    params: { organizationId?: string };
}) => req.params.organizationId;

const sendEinError = (res: Response, error: unknown): void => {
    if (!(error instanceof EinServiceError)) {
        res.status(500).json({
            error: "INTERNAL_SERVER_ERROR",
            message: "An unexpected error occurred."
        });
        return;
    }

    const statusByCode: Record<EinServiceError["code"], number> = {
        BUSINESS_NOT_FOUND: 404,
        VERIFICATION_ITEM_NOT_FOUND: 404,
        EIN_VERIFICATION_ATTEMPT_NOT_FOUND: 404,
        EIN_NOT_FOUND: 404,
        FORBIDDEN: 403,
        EIN_ENCRYPTION_UNAVAILABLE: 503,
        EIN_DECRYPTION_FAILED: 500,
        EIN_VERIFICATION_NOT_CONFIGURED: 503,
        EIN_VERIFICATION_INVALID_STATE: 409,
        EIN_VERIFICATION_FAILED: 502,
        INTERNAL_SERVER_ERROR: 500
    };

    const messageByCode: Record<EinServiceError["code"], string> = {
        BUSINESS_NOT_FOUND: "Business not found.",
        VERIFICATION_ITEM_NOT_FOUND: "Verification item not found.",
        EIN_VERIFICATION_ATTEMPT_NOT_FOUND: "EIN verification attempt not found.",
        EIN_NOT_FOUND: "EIN not found.",
        FORBIDDEN: "You do not have permission to perform this action.",
        EIN_ENCRYPTION_UNAVAILABLE: "EIN encryption is unavailable.",
        EIN_DECRYPTION_FAILED: "EIN decryption failed.",
        EIN_VERIFICATION_NOT_CONFIGURED:
            "EIN verification is not configured.",
        EIN_VERIFICATION_INVALID_STATE:
            "EIN verification cannot start from the current item status.",
        EIN_VERIFICATION_FAILED: "EIN verification could not be completed.",
        INTERNAL_SERVER_ERROR: "An unexpected error occurred."
    };

    res.status(statusByCode[error.code]).json({
        error: error.code,
        message: messageByCode[error.code]
    });
};

router.put(
    "/organizations/:organizationId/businesses/:businessId/ein",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(einIntakeParamsSchema),
    requirePermission("business:update", organizationIdFromParams),
    validateBody(einIntakeSchema),
    async (req, res) => {
        const authentication = req.authentication;

        if (!authentication) {
            res.status(401).json({
                error: "UNAUTHORIZED",
                message: "A valid Bearer access token is required."
            });
            return;
        }

        try {
            const { organizationId, businessId } = req.params as {
                organizationId: string;
                businessId: string;
            };
            const result = await intakeEin(
                authentication.user.id,
                organizationId,
                businessId,
                req.body as EinIntakeInput
            );
            res.status(200).json(result);
        } catch (error) {
            sendEinError(res, error);
        }
    }
);

router.post(
    "/businesses/:businessId/ein/reveal",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(einRevealParamsSchema),
    requirePermission("ein:reveal"),
    async (req, res) => {
        const authentication = req.authentication;

        if (!authentication) {
            res.status(401).json({
                error: "UNAUTHORIZED",
                message: "A valid Bearer access token is required."
            });
            return;
        }

        try {
            const { businessId } = req.params as { businessId: string };
            const result = await revealEin(
                authentication.user.id,
                businessId
            );
            res.status(200).json(result);
        } catch (error) {
            sendEinError(res, error);
        }
    }
);

router.post(
    "/ein-verifications/:einVerificationId/abandon",
    requireAuthentication,
    loadApplicationIdentity,
    requirePermission("admin:verification_review"),
    validateParams(einAttemptParamsSchema),
    validateBody(einAttemptAbandonSchema),
    async (req, res) => {
        const authentication = req.authentication;
        if (!authentication) {
            res.status(401).json({
                error: "UNAUTHORIZED",
                message: "A valid Bearer access token is required."
            });
            return;
        }

        try {
            const { einVerificationId } = req.params as { einVerificationId: string };
            const result = await abandonEinVerification(
                authentication.user.id,
                einVerificationId,
                req.body as EinAttemptAbandonInput
            );
            res.status(200).json(result);
        } catch (error) {
            sendEinError(res, error);
        }
    }
);

router.post(
    "/verification-items/:verificationItemId/ein/verify",
    requireAuthentication,
    loadApplicationIdentity,
    validateParams(einVerificationParamsSchema),
    requirePermission("admin:verification_review"),
    async (req, res) => {
        const authentication = req.authentication;

        if (!authentication) {
            res.status(401).json({
                error: "UNAUTHORIZED",
                message: "A valid Bearer access token is required."
            });
            return;
        }

        try {
            const { verificationItemId } = req.params as {
                verificationItemId: string;
            };
            const result = await verifyEin(
                authentication.accessToken,
                authentication.user.id,
                verificationItemId
            );
            res.status(200).json(result);
        } catch (error) {
            sendEinError(res, error);
        }
    }
);

export { router as einRouter };

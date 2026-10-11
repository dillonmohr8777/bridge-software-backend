import { Router, type RequestHandler, type Response } from "express";

import { requireAuthentication } from "../../middleware/authentication.js";
import { loadApplicationIdentity } from "../../middleware/application-identity.js";
import { validateBody } from "../../middleware/validation.js";
import {
    clearAuthCookies,
    getCookieAuthTokens,
    setAuthCookies
} from "../../http/auth-cookies.js";
import {
    accountSettingsSchema,
    emailRequestSchema,
    loginSchema,
    recoverySessionSchema,
    registrationSchema,
    resetPasswordSchema,
    type AccountSettingsInput,
    type EmailRequestInput,
    type LoginInput,
    type RecoverySessionInput,
    type RegistrationInput,
    type ResetPasswordInput
} from "../../schemas/authentication.js";
import {
    AccountSettingsServiceError,
    AuthenticationServiceError,
    establishRecoverySession,
    login,
    logout,
    register,
    requestPasswordReset,
    resendVerification,
    resetPassword,
    updateAccountSettings
} from "../../services/authentication.js";

const router = Router();

export const authFailureStatus = (error: AuthenticationServiceError): number => {
    switch (error.code) {
        case "INVALID_CREDENTIALS":
            return 401;
        case "EMAIL_NOT_VERIFIED":
            return 403;
        case "AUTH_RATE_LIMITED":
            return 429;
        case "AUTH_PROVIDER_UNAVAILABLE":
            return 503;
        default:
            return 400;
    }
};

const sendAuthFailure = (
    res: Response,
    error: unknown
): void => {
    if (error instanceof AuthenticationServiceError) {
        const messages: Partial<Record<typeof error.code, string>> = {
            AUTH_RATE_LIMITED:
                "Too many authentication requests. Please try again later.",
            EMAIL_NOT_VERIFIED: "Please verify your email before signing in.",
            INVALID_CREDENTIALS: "Invalid email or password.",
            AUTH_PROVIDER_UNAVAILABLE:
                "Authentication service is temporarily unavailable."
        };
        res.status(authFailureStatus(error)).json({
            error: error.code,
            message:
                messages[error.code] ??
                "The authentication request could not be completed."
        });
        return;
    }

    res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred."
    });
};

router.post("/register", validateBody(registrationSchema), async (req, res) => {
    try {
        const result = await register(req.body as RegistrationInput);
        res.status(201).json(result);
    } catch (error) {
        sendAuthFailure(res, error);
    }
});

export const createLoginHandler = (
    service: typeof login = login
): RequestHandler => async (req, res) => {
    try {
        const result = await service(req.body as LoginInput);
        setAuthCookies(res, result);
        res.status(200).json({ user: result.user });
    } catch (error) {
        sendAuthFailure(res, error);
    }
};

router.post("/login", validateBody(loginSchema), createLoginHandler());

router.post(
    "/recovery-session",
    validateBody(recoverySessionSchema),
    async (req, res) => {
        try {
            const session = await establishRecoverySession(req.body as RecoverySessionInput);
            setAuthCookies(res, session);
            res.status(204).send();
        } catch (error) {
            sendAuthFailure(res, error);
        }
    }
);

export const createLogoutHandler = (
    service: typeof logout = logout
): RequestHandler => async (req, res) => {
    const bearerToken = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const cookieTokens = getCookieAuthTokens(req);
    clearAuthCookies(res);
    await service(
        bearerToken ?? cookieTokens.accessToken,
        cookieTokens.refreshToken
    );
    res.status(204).send();
};

router.post("/logout", createLogoutHandler());

router.post(
    "/resend-verification",
    validateBody(emailRequestSchema),
    async (req, res) => {
        try {
            await resendVerification(req.body as EmailRequestInput);
            res.status(202).json({
                code: "AUTH_EMAIL_REQUEST_ACCEPTED",
                message:
                    "If the account is eligible, a verification email will be sent."
            });
        } catch (error) {
            sendAuthFailure(res, error);
        }
    }
);

router.post(
    "/forgot-password",
    validateBody(emailRequestSchema),
    async (req, res) => {
        try {
            await requestPasswordReset(req.body as EmailRequestInput);
            res.status(202).json({
                code: "AUTH_EMAIL_REQUEST_ACCEPTED",
                message:
                    "If the account is eligible, a password recovery email will be sent."
            });
        } catch (error) {
            sendAuthFailure(res, error);
        }
    }
);

router.post(
    "/reset-password",
    requireAuthentication,
    validateBody(resetPasswordSchema),
    async (req, res) => {
        const authentication = req.authentication;

        if (!authentication || !authentication.refreshToken) {
            res.status(401).json({
                error: "UNAUTHORIZED",
                message: "A valid recovery session is required."
            });
            return;
        }

        try {
            await resetPassword(
                authentication.user.id,
                authentication.accessToken,
                authentication.refreshToken,
                req.body as ResetPasswordInput
            );
            res.status(200).json({
                code: "AUTH_PASSWORD_RESET_COMPLETED",
                message: "Password updated successfully."
            });
        } catch (error) {
            sendAuthFailure(res, error);
        }
    }
);

export const createUpdateAccountSettingsHandler = (
    service: typeof updateAccountSettings = updateAccountSettings
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
            authentication.user.id,
            authentication.accessToken,
            req.body as AccountSettingsInput
        );
        res.status(200).json({ profile });
    } catch (error) {
        const known = error instanceof AccountSettingsServiceError;
        res.status(500).json({
            error: known
                ? "ACCOUNT_SETTINGS_UPDATE_FAILED"
                : "INTERNAL_SERVER_ERROR",
            message: known
                ? "Account settings could not be updated."
                : "An unexpected error occurred."
        });
    }
};

router.patch(
    "/me",
    requireAuthentication,
    validateBody(accountSettingsSchema),
    createUpdateAccountSettingsHandler()
);

router.get("/me", requireAuthentication, loadApplicationIdentity, (req, res) => {
    const identity = req.identity;

    if (!identity) {
        res.status(503).json({
            error: "APPLICATION_IDENTITY_UNAVAILABLE",
            message: "Application identity is temporarily unavailable."
        });
        return;
    }

    res.status(200).json({
        user: {
            id: identity.userId,
            email: identity.email,
            accountType: identity.accountType,
            platformRoles: identity.platformRoles,
            profile: identity.profile
        },
        memberships: identity.memberships
    });
});

export { router as authRouter };

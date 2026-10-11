import { env } from "../config/index.js";
import {
    createPublicSupabaseClient,
    createUserScopedSupabaseClient
} from "../lib/supabase.js";
import type {
    AccountSettingsInput,
    EmailRequestInput,
    LoginInput,
    RecoverySessionInput,
    RegistrationInput,
    ResetPasswordInput
} from "../schemas/authentication.js";

export class AccountSettingsServiceError extends Error {
    constructor() {
        super("ACCOUNT_SETTINGS_UPDATE_FAILED");
        this.name = "AccountSettingsServiceError";
    }
}

export const updateAccountSettings = async (
    userId: string,
    accessToken: string,
    input: AccountSettingsInput
) => {
    const changes = {
        ...(input.displayName === undefined
            ? {}
            : { display_name: input.displayName }),
        ...(input.phone === undefined ? {} : { phone: input.phone })
    };
    const { data, error } = await createUserScopedSupabaseClient(accessToken)
        .from("user_profiles")
        .update(changes)
        .eq("id", userId)
        .select("display_name, phone")
        .maybeSingle();

    if (error || !data) {
        throw new AccountSettingsServiceError();
    }

    return {
        displayName: data.display_name as string | null,
        phone: data.phone as string | null
    };
};

export type AuthenticationFailureCode =
    | "AUTH_REGISTRATION_FAILED"
    | "AUTH_LOGIN_FAILED"
    | "AUTH_RATE_LIMITED"
    | "EMAIL_NOT_VERIFIED"
    | "INVALID_CREDENTIALS"
    | "AUTH_PASSWORD_RESET_FAILED"
    | "AUTH_PROVIDER_UNAVAILABLE";

export class AuthenticationServiceError extends Error {
    constructor(
        public readonly code: AuthenticationFailureCode,
        public readonly providerStatus?: number
    ) {
        super(code);
        this.name = "AuthenticationServiceError";
    }
}

type SupabaseAuthFailure = {
    code?: string | undefined;
    status?: number | undefined;
};

const logAuthFailure = (operation: string, error: SupabaseAuthFailure): void => {
    console.warn("Supabase authentication request failed", {
        operation,
        providerCode: error.code ?? "unknown",
        status: error.status ?? "unknown"
    });
};

export const classifySupabaseAuthFailure = (
    operation: string,
    error: SupabaseAuthFailure,
    fallback: AuthenticationFailureCode
): AuthenticationServiceError => {
    logAuthFailure(operation, error);

    if (error.status === 429) {
        return new AuthenticationServiceError("AUTH_RATE_LIMITED", 429);
    }

    if (error.status === 0 || (error.status !== undefined && error.status >= 500)) {
        return new AuthenticationServiceError("AUTH_PROVIDER_UNAVAILABLE", error.status);
    }

    if (operation === "login") {
        if (error.code === "email_not_confirmed") {
            return new AuthenticationServiceError("EMAIL_NOT_VERIFIED", error.status);
        }

        // Deliberately collapse all other authentication rejections so the API
        // does not disclose whether an email address is registered.
        return new AuthenticationServiceError("INVALID_CREDENTIALS", error.status);
    }

    return new AuthenticationServiceError(fallback, error.status);
};

const providerFailure = (): never => {
    throw new AuthenticationServiceError("AUTH_PROVIDER_UNAVAILABLE");
};

export const buildRegistrationCredentials = (input: RegistrationInput) => {
    const credentials = { email: input.email, password: input.password };

    return {
        ...credentials,
        options: {
            emailRedirectTo: env.EMAIL_VERIFICATION_REDIRECT_URL,
            // Profile creation is trigger-owned; use the snake_case metadata key
            // expected when auth.users is projected into public.user_profiles.
            ...(input.displayName === undefined
                ? {}
                : { data: { display_name: input.displayName } })
        }
    };
};

export const buildResendVerificationCredentials = (input: EmailRequestInput) => ({
    type: "signup" as const,
    email: input.email,
    options: {
        emailRedirectTo: env.EMAIL_VERIFICATION_REDIRECT_URL
    }
});

export const register = async (input: RegistrationInput) => {
    const client = createPublicSupabaseClient();

    try {
        const { data, error } = await client.auth.signUp(
            buildRegistrationCredentials(input)
        );

        if (error) {
            throw classifySupabaseAuthFailure(
                "register",
                error,
                "AUTH_REGISTRATION_FAILED"
            );
        }

        if (!data.user) {
            throw new AuthenticationServiceError("AUTH_REGISTRATION_FAILED");
        }

        return {
            user: {
                id: data.user.id,
                email: data.user.email ?? input.email
            },
            emailConfirmationRequired: data.session === null
        };
    } catch (error) {
        if (error instanceof AuthenticationServiceError) {
            throw error;
        }
        return providerFailure();
    }
};

export const login = async (input: LoginInput) => {
    const client = createPublicSupabaseClient();

    try {
        const { data, error } = await client.auth.signInWithPassword(input);

        if (error) {
            throw classifySupabaseAuthFailure("login", error, "AUTH_LOGIN_FAILED");
        }

        if (!data.user || !data.session) {
            throw new AuthenticationServiceError("INVALID_CREDENTIALS");
        }

        return {
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresAt: data.session.expires_at ?? null,
            expiresIn: data.session.expires_in,
            tokenType: data.session.token_type,
            user: {
                id: data.user.id,
                email: data.user.email ?? null
            }
        };
    } catch (error) {
        if (error instanceof AuthenticationServiceError) {
            throw error;
        }
        return providerFailure();
    }
};

export const logout = async (
    accessToken?: string,
    refreshToken?: string
): Promise<void> => {
    if (!refreshToken) return;

    const client = createPublicSupabaseClient();
    try {
        if (accessToken) {
            const established = await client.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken
            });
            if (established.error) return;
        } else {
            const refreshed = await client.auth.refreshSession({
                refresh_token: refreshToken
            });
            if (refreshed.error) return;
        }
        await client.auth.signOut({ scope: "local" });
    } catch {
        // Logout is intentionally idempotent. Cookies are cleared by the route
        // even when the upstream session is already invalid or unavailable.
    }
};

export const resendVerification = async (
    input: EmailRequestInput
): Promise<void> => {
    const client = createPublicSupabaseClient();

    try {
        const { error } = await client.auth.resend(
            buildResendVerificationCredentials(input)
        );
        if (error) {
            const failure = classifySupabaseAuthFailure(
                "resend-verification",
                error,
                "AUTH_REGISTRATION_FAILED"
            );
            if (
                failure.code === "AUTH_RATE_LIMITED" ||
                failure.code === "AUTH_PROVIDER_UNAVAILABLE"
            ) {
                throw failure;
            }
        }
    } catch (error) {
        if (error instanceof AuthenticationServiceError) throw error;
        providerFailure();
    }
};

export const requestPasswordReset = async (
    input: EmailRequestInput
): Promise<void> => {
    const client = createPublicSupabaseClient();

    try {
        const { error } = await client.auth.resetPasswordForEmail(input.email, {
            redirectTo: env.PASSWORD_RESET_REDIRECT_URL
        });
        if (error) {
            const failure = classifySupabaseAuthFailure(
                "forgot-password",
                error,
                "AUTH_PASSWORD_RESET_FAILED"
            );
            if (
                failure.code === "AUTH_RATE_LIMITED" ||
                failure.code === "AUTH_PROVIDER_UNAVAILABLE"
            ) {
                throw failure;
            }
        }
    } catch (error) {
        if (error instanceof AuthenticationServiceError) throw error;
        providerFailure();
    }
};

export const resetPassword = async (
    userId: string,
    accessToken: string,
    refreshToken: string,
    input: ResetPasswordInput
): Promise<void> => {
    const client = createPublicSupabaseClient();

    try {
        // Supabase recovery links establish a session in the redirecting client.
        // The frontend passes that session's access token as the Bearer token and
        // its paired refresh token here; no custom reset token is accepted.
        const { data: sessionData, error: sessionError } =
            await client.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken
            });

        if (
            sessionError ||
            !sessionData.session ||
            sessionData.session.user.id !== userId
        ) {
            if (sessionError) {
                throw classifySupabaseAuthFailure(
                    "reset-password-session",
                    sessionError,
                    "AUTH_PASSWORD_RESET_FAILED"
                );
            }
            throw new AuthenticationServiceError(
                "AUTH_PASSWORD_RESET_FAILED"
            );
        }

        const { error } = await client.auth.updateUser({
            password: input.newPassword
        });

        if (error) {
            throw classifySupabaseAuthFailure(
                "reset-password-update",
                error,
                "AUTH_PASSWORD_RESET_FAILED"
            );
        }
    } catch (error) {
        if (error instanceof AuthenticationServiceError) {
            throw error;
        }
        providerFailure();
    }
};

export const establishRecoverySession = async (input: RecoverySessionInput) => {
    const client = createPublicSupabaseClient();
    const { data, error } = await client.auth.setSession({
        access_token: input.accessToken,
        refresh_token: input.refreshToken
    });
    if (error || !data.session || !data.user) {
        throw new AuthenticationServiceError("AUTH_PASSWORD_RESET_FAILED");
    }
    return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in
    };
};

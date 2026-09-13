import { z } from "zod";

const optionalString = z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
);

const optionalEinEncryptionKey = z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().refine((value) => {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
            return false;
        }

        return Buffer.from(value, "base64").byteLength === 32;
    }, "EIN_ENCRYPTION_KEY must be a base64 encoded 32-byte key.").optional()
);

export const corsOriginsSchema = z.string().transform((value, context) => {
    const origins = value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

    const hasInvalidOrigin = origins.some((origin) => {
        if (!z.url().safeParse(origin).success || origin.includes("*")) return true;

        const parsed = new URL(origin);
        return parsed.origin !== origin || parsed.username !== "" || parsed.password !== "";
    });

    if (origins.length === 0 || hasInvalidOrigin) {
        context.addIssue({
            code: "custom",
            message:
                "CORS_ORIGINS must contain one or more comma-separated URL origins."
        });
        return z.NEVER;
    }

    return origins;
});

const envSchema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),

    API_PORT: z.coerce.number().int().positive().default(4000),

    PORT: z.coerce.number().int().positive().optional(),

    API_URL: z.url().default("http://localhost:4000"),

    WEB_URL: z.url().default("http://localhost:5173"),

    CORS_ORIGINS: corsOriginsSchema,

    DEPLOYMENT_ENVIRONMENT: z
        .enum(["development", "test", "staging", "production"])
        .optional(),

    SUPABASE_URL: z.url(),

    SUPABASE_ANON_KEY: z.string().min(1),

    EMAIL_VERIFICATION_REDIRECT_URL: z.url(),

    PASSWORD_RESET_REDIRECT_URL: z.url(),

    SUPABASE_SERVICE_ROLE_KEY: optionalString,

    DATABASE_URL: optionalString,

    EIN_VERIFICATION_PROVIDER: optionalString,

    EIN_VERIFICATION_API_KEY: optionalString,

    EIN_ENCRYPTION_KEY: optionalEinEncryptionKey,

    EIN_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),

    RESEND_API_KEY: optionalString,

    DIRECTORY_EMAIL_FROM: optionalString,

    DIRECTORY_EMAIL_REPLY_TO: z.preprocess(
        (value) => (value === "" ? undefined : value),
        z.email().optional()
    )
}).superRefine((value, context) => {
    const emailValues = [value.RESEND_API_KEY, value.DIRECTORY_EMAIL_FROM];
    if (emailValues.some(Boolean) && !emailValues.every(Boolean)) {
        context.addIssue({ code: "custom", message: "RESEND_API_KEY and DIRECTORY_EMAIL_FROM must be configured together." });
    }
    if (emailValues.every(Boolean) && !value.SUPABASE_SERVICE_ROLE_KEY) {
        context.addIssue({ code: "custom", message: "SUPABASE_SERVICE_ROLE_KEY is required for directory email delivery." });
    }
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
    console.error("Invalid environment configuration:");
    console.error(z.prettifyError(result.error));
    process.exit(1);
}

export const env = result.data;

import { z } from "zod";

const emailSchema = z.string().trim().toLowerCase().email().max(254);

const passwordSchema = z
    .string()
    .min(12, "Password must contain at least 12 characters.")
    .max(128, "Password must contain at most 128 characters.")
    .regex(/[a-z]/, "Password must contain a lowercase letter.")
    .regex(/[A-Z]/, "Password must contain an uppercase letter.")
    .regex(/[0-9]/, "Password must contain a number.")
    .regex(/[^A-Za-z0-9]/, "Password must contain a special character.");

export const registrationSchema = z.object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(100).optional()
});

export const loginSchema = z.object({
    email: emailSchema,
    password: z.string().min(1).max(128)
});

export const emailRequestSchema = z.object({
    email: emailSchema
});

export const resetPasswordSchema = z.object({
    newPassword: passwordSchema
});

export const recoverySessionSchema = z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1)
});

export const accountSettingsSchema = z
    .object({
        displayName: z.string().trim().min(1).max(100).nullable().optional(),
        phone: z.string().trim().max(30).nullable().optional()
    })
    .strict()
    .refine(
        (settings) =>
            settings.displayName !== undefined || settings.phone !== undefined,
        { message: "At least one account setting must be provided." }
    );

export type RegistrationInput = z.infer<typeof registrationSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type EmailRequestInput = z.infer<typeof emailRequestSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type RecoverySessionInput = z.infer<typeof recoverySessionSchema>;
export type AccountSettingsInput = z.infer<typeof accountSettingsSchema>;

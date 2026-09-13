import { z } from "zod";

const einSchema = z
    .string()
    .trim()
    .regex(/^[0-9]{2}-?[0-9]{7}$/, "EIN must contain exactly nine digits.")
    .transform((value) => value.replace("-", ""));

export const einIntakeSchema = z.object({ ein: einSchema }).strict();

export const einIntakeParamsSchema = z.object({
    organizationId: z.uuid(),
    businessId: z.uuid()
});

export const einVerificationParamsSchema = z.object({
    verificationItemId: z.uuid()
});

export const einRevealParamsSchema = z.object({
    businessId: z.uuid()
});

export const einAttemptParamsSchema = z.object({
    einVerificationId: z.uuid()
});

export const einAttemptAbandonSchema = z.object({
    reason: z.string().trim().min(10).max(500)
}).strict();

export type EinIntakeInput = z.infer<typeof einIntakeSchema>;
export type EinAttemptAbandonInput = z.infer<typeof einAttemptAbandonSchema>;

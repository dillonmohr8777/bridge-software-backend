import { z } from "zod";

import {
    createAdminSupabaseClient,
    createUserScopedSupabaseClient,
    SupabaseAdminNotConfiguredError
} from "../lib/supabase.js";
import type { EinAttemptAbandonInput, EinIntakeInput } from "../schemas/ein.js";
import {
    decryptEin,
    EinDecryptionError,
    EinEncryptionUnavailableError,
    encryptEin
} from "./ein-encryption.js";
import {
    EinProviderNotConfiguredError,
    getEinVerificationProvider
} from "./ein-verification-provider.js";

const intakeResultSchema = z.object({
    business_id: z.uuid(),
    ein_last_four: z.string().regex(/^[0-9]{4}$/),
    verification_case_id: z.uuid(),
    verification_item_id: z.uuid()
});

const secretSchema = z.object({
    business_id: z.uuid(),
    ciphertext: z.string().min(1),
    iv: z.string().min(1),
    auth_tag: z.string().min(1),
    key_version: z.number().int().positive()
});

const verificationSecretSchema = secretSchema.extend({
    legal_name: z.string(),
    ein_last_four: z.string().regex(/^[0-9]{4}$/),
    secret_version: z.uuid()
});

const requestResultSchema = z.object({
    ein_verification_id: z.uuid(),
    organization_id: z.uuid(),
    business_id: z.uuid(),
    legal_name: z.string(),
    verification_item_id: z.uuid()
});

export type EinFailureCode =
    | "BUSINESS_NOT_FOUND"
    | "VERIFICATION_ITEM_NOT_FOUND"
    | "EIN_VERIFICATION_ATTEMPT_NOT_FOUND"
    | "EIN_NOT_FOUND"
    | "FORBIDDEN"
    | "EIN_ENCRYPTION_UNAVAILABLE"
    | "EIN_DECRYPTION_FAILED"
    | "EIN_VERIFICATION_NOT_CONFIGURED"
    | "EIN_VERIFICATION_INVALID_STATE"
    | "EIN_VERIFICATION_FAILED"
    | "INTERNAL_SERVER_ERROR";

export class EinServiceError extends Error {
    constructor(public readonly code: EinFailureCode) {
        super(code);
        this.name = "EinServiceError";
    }
}

const mapRpcError = (
    code: string | undefined,
    notFoundCode:
        | "BUSINESS_NOT_FOUND"
        | "VERIFICATION_ITEM_NOT_FOUND"
        | "EIN_VERIFICATION_ATTEMPT_NOT_FOUND"
        | "EIN_NOT_FOUND"
): never => {
    if (code === "P0002") {
        throw new EinServiceError(notFoundCode);
    }
    if (code === "P0003") {
        throw new EinServiceError("EIN_NOT_FOUND");
    }
    if (code === "42501") {
        throw new EinServiceError("FORBIDDEN");
    }
    if (code === "55000") {
        throw new EinServiceError("EIN_VERIFICATION_INVALID_STATE");
    }
    throw new EinServiceError("INTERNAL_SERVER_ERROR");
};

const getAdminClient = () => {
    try {
        return createAdminSupabaseClient();
    } catch (error) {
        if (error instanceof SupabaseAdminNotConfiguredError) {
            throw new EinServiceError("INTERNAL_SERVER_ERROR");
        }
        throw error;
    }
};

const decryptStoredEin = (secret: z.infer<typeof secretSchema>): string => {
    try {
        const ein = decryptEin({
            ciphertext: secret.ciphertext,
            iv: secret.iv,
            authTag: secret.auth_tag,
            keyVersion: secret.key_version
        });

        if (!/^[0-9]{9}$/.test(ein)) {
            throw new EinDecryptionError();
        }

        return ein;
    } catch (error) {
        if (error instanceof EinEncryptionUnavailableError) {
            throw new EinServiceError("EIN_ENCRYPTION_UNAVAILABLE");
        }
        throw new EinServiceError("EIN_DECRYPTION_FAILED");
    }
};

export const intakeEin = async (
    actorUserId: string,
    organizationId: string,
    businessId: string,
    input: EinIntakeInput
) => {
    let encrypted;
    try {
        encrypted = encryptEin(input.ein);
    } catch (error) {
        if (error instanceof EinEncryptionUnavailableError) {
            throw new EinServiceError("EIN_ENCRYPTION_UNAVAILABLE");
        }
        throw new EinServiceError("INTERNAL_SERVER_ERROR");
    }

    const client = getAdminClient();
    const { data, error } = await client
        .rpc("store_business_ein_secret", {
            p_actor_user_id: actorUserId,
            p_organization_id: organizationId,
            p_business_id: businessId,
            p_ein_last_four: input.ein.slice(-4),
            p_ciphertext: encrypted.ciphertext,
            p_iv: encrypted.iv,
            p_auth_tag: encrypted.authTag,
            p_key_version: encrypted.keyVersion
        })
        .single();

    if (error) {
        return mapRpcError(error.code, "BUSINESS_NOT_FOUND");
    }

    const parsed = intakeResultSchema.safeParse(data);
    if (!parsed.success) {
        throw new EinServiceError("INTERNAL_SERVER_ERROR");
    }

    return {
        businessId: parsed.data.business_id,
        einLastFour: parsed.data.ein_last_four
    };
};

export const revealEin = async (actorUserId: string, businessId: string) => {
    const client = getAdminClient();
    const { data, error } = await client
        .rpc("get_business_ein_secret_for_reveal", {
            p_actor_user_id: actorUserId,
            p_business_id: businessId
        })
        .single();

    if (error) {
        return mapRpcError(error.code, "EIN_NOT_FOUND");
    }

    const secret = secretSchema.safeParse(data);
    if (!secret.success) {
        throw new EinServiceError("INTERNAL_SERVER_ERROR");
    }

    const ein = decryptStoredEin(secret.data);
    return {
        businessId: secret.data.business_id,
        ein: `${ein.slice(0, 2)}-${ein.slice(2)}`
    };
};

export const verifyEin = async (
    accessToken: string,
    actorUserId: string,
    verificationItemId: string
) => {
    let provider;
    try {
        provider = getEinVerificationProvider();
    } catch (error) {
        if (error instanceof EinProviderNotConfiguredError) {
            throw new EinServiceError("EIN_VERIFICATION_NOT_CONFIGURED");
        }
        throw new EinServiceError("INTERNAL_SERVER_ERROR");
    }

    const adminClient = getAdminClient();
    const { data: secretData, error: secretError } = await adminClient
        .rpc("get_ein_secret_for_verification", {
            p_actor_user_id: actorUserId,
            p_verification_item_id: verificationItemId
        })
        .single();

    if (secretError) {
        return mapRpcError(secretError.code, "VERIFICATION_ITEM_NOT_FOUND");
    }

    const secret = verificationSecretSchema.safeParse(secretData);
    if (!secret.success) {
        throw new EinServiceError("INTERNAL_SERVER_ERROR");
    }

    const ein = decryptStoredEin(secret.data);
    if (ein.slice(-4) !== secret.data.ein_last_four) {
        throw new EinServiceError("EIN_DECRYPTION_FAILED");
    }

    const client = createUserScopedSupabaseClient(accessToken);
    const { data, error } = await client
        .rpc("request_ein_verification", {
            p_verification_item_id: verificationItemId,
            p_ein_last_four: secret.data.ein_last_four,
            p_provider: provider.name,
            p_ein_secret_version: secret.data.secret_version
        })
        .single();

    if (error) {
        return mapRpcError(error.code, "VERIFICATION_ITEM_NOT_FOUND");
    }

    const request = requestResultSchema.safeParse(data);
    if (!request.success) {
        throw new EinServiceError("INTERNAL_SERVER_ERROR");
    }

    try {
        const result = await provider.verifyEin({
            ein,
            legalName: secret.data.legal_name
        });

        const { error: completionError } = await adminClient.rpc(
            "complete_ein_provider_evidence",
            {
                p_ein_verification_id: request.data.ein_verification_id,
                p_provider_reference: result.providerReference,
                p_result_status: result.status,
                p_result_reason: result.reason
            }
        );

        if (completionError) {
            throw new EinServiceError("INTERNAL_SERVER_ERROR");
        }

        return {
            verificationItemId: request.data.verification_item_id,
            provider: provider.name,
            providerReference: result.providerReference,
            status: "verification_requested",
            suggestedDecision: result.status,
            reason: result.reason
        };
    } catch (error) {
        if (error instanceof EinServiceError) {
            throw error;
        }

        const { error: failureCompletionError } = await adminClient.rpc(
            "complete_ein_provider_evidence",
            {
                p_ein_verification_id: request.data.ein_verification_id,
                p_provider_reference: null,
                p_result_status: "provider_error",
                p_result_reason: "The provider request could not be completed."
            }
        );

        if (failureCompletionError) {
            throw new EinServiceError("INTERNAL_SERVER_ERROR");
        }

        throw new EinServiceError("EIN_VERIFICATION_FAILED");
    }
};

export const abandonEinVerification = async (
    actorUserId: string,
    einVerificationId: string,
    input: EinAttemptAbandonInput
) => {
    const { error } = await getAdminClient().rpc("abandon_ein_provider_attempt", {
        p_actor_user_id: actorUserId,
        p_ein_verification_id: einVerificationId,
        p_reason: input.reason
    });

    if (error) {
        return mapRpcError(error.code, "EIN_VERIFICATION_ATTEMPT_NOT_FOUND");
    }

    return { einVerificationId, status: "abandoned" as const };
};

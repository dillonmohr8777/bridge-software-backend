import { env } from "../config/index.js";
import { z } from "zod";

export interface EinVerificationProviderInput {
    ein: string;
    legalName: string;
}

export interface EinVerificationProviderResult {
    providerReference: string | null;
    status: "verified" | "rejected" | "correction_required";
    reason: string | null;
    rawResponse?: unknown;
}

export interface EinVerificationProvider {
    readonly name: string;
    verifyEin(
        input: EinVerificationProviderInput
    ): Promise<EinVerificationProviderResult>;
}

export class EinProviderNotConfiguredError extends Error {
    constructor() {
        super("EIN verification provider is not configured.");
        this.name = "EinProviderNotConfiguredError";
    }
}

export class EinProviderRequestError extends Error {
    constructor() {
        super("EIN verification provider request failed.");
        this.name = "EinProviderRequestError";
    }
}

const tinComplyResponseSchema = z.object({
    id: z.string().min(1),
    irsTinNameMatchingResult: z.object({
        completed: z.literal(true),
        message: z.string().min(1),
        result: z.number().int()
    })
});

export const createTinComplyProvider = (
    apiKey: string,
    fetcher: typeof fetch = fetch
): EinVerificationProvider => ({
    name: "tincomply",
    async verifyEin(input) {
        let response: Response;
        try {
            response = await fetcher(
                "https://www.tincomply.com/api/v1/validate/irs-tin-name-matching",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-Key": apiKey
                    },
                    body: JSON.stringify({ tin: input.ein, name: input.legalName }),
                    signal: AbortSignal.timeout(15_000)
                }
            );
        } catch {
            throw new EinProviderRequestError();
        }

        if (!response.ok) throw new EinProviderRequestError();

        let payload: unknown;
        try {
            payload = JSON.parse(await response.text());
        } catch {
            throw new EinProviderRequestError();
        }

        const parsed = tinComplyResponseSchema.safeParse(payload);
        if (!parsed.success) throw new EinProviderRequestError();

        const result = parsed.data.irsTinNameMatchingResult;
        const status = [7, 8].includes(result.result)
            ? "verified" as const
            : result.result === 3
                ? "correction_required" as const
                : [2, 6].includes(result.result)
                    ? "rejected" as const
                    : null;

        if (!status) throw new EinProviderRequestError();

        return {
            providerReference: parsed.data.id,
            status,
            reason: result.message
        };
    }
});

export const getEinVerificationProvider = (): EinVerificationProvider => {
    if (!env.EIN_VERIFICATION_PROVIDER || !env.EIN_VERIFICATION_API_KEY) {
        throw new EinProviderNotConfiguredError();
    }

    if (env.EIN_VERIFICATION_PROVIDER.toLowerCase() === "tincomply") {
        return createTinComplyProvider(env.EIN_VERIFICATION_API_KEY);
    }

    throw new EinProviderNotConfiguredError();
};

import { z } from "zod";

import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { CreateBusinessInput } from "../schemas/businesses.js";

const businessRowSchema = z.object({
    id: z.uuid(),
    organization_id: z.uuid(),
    legal_name: z.string(),
    dba_name: z.string().nullable(),
    status: z.enum(["active", "inactive", "archived"]),
    created_at: z.string(),
    updated_at: z.string()
});

export type BusinessFailureCode =
    | "BUSINESS_LIST_FAILED"
    | "BUSINESS_CREATE_FAILED"
    | "INTERNAL_SERVER_ERROR";

export class BusinessServiceError extends Error {
    constructor(public readonly code: BusinessFailureCode) {
        super(code);
        this.name = "BusinessServiceError";
    }
}

export interface BusinessResponse {
    id: string;
    organizationId: string;
    legalName: string;
    dbaName: string | null;
    status: "active" | "inactive" | "archived";
    createdAt: string;
    updatedAt: string;
}

export const projectBusinessRow = (row: unknown): BusinessResponse => {
    const parsed = businessRowSchema.safeParse(row);

    if (!parsed.success) {
        throw new BusinessServiceError("INTERNAL_SERVER_ERROR");
    }

    return {
        id: parsed.data.id,
        organizationId: parsed.data.organization_id,
        legalName: parsed.data.legal_name,
        dbaName: parsed.data.dba_name,
        status: parsed.data.status,
        createdAt: parsed.data.created_at,
        updatedAt: parsed.data.updated_at
    };
};

const safeBusinessColumns =
    "id, organization_id, legal_name, dba_name, status, created_at, updated_at";

export const listBusinesses = async (
    accessToken: string,
    organizationId: string
): Promise<BusinessResponse[]> => {
    const client = createUserScopedSupabaseClient(accessToken);
    const { data, error } = await client
        .from("businesses")
        .select(safeBusinessColumns)
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: true });

    if (error) {
        throw new BusinessServiceError("BUSINESS_LIST_FAILED");
    }

    const parsed = z.array(businessRowSchema).safeParse(data);
    if (!parsed.success) {
        throw new BusinessServiceError("INTERNAL_SERVER_ERROR");
    }

    return parsed.data.map(projectBusinessRow);
};

export const createBusiness = async (
    accessToken: string,
    organizationId: string,
    input: CreateBusinessInput
): Promise<BusinessResponse> => {
    const client = createUserScopedSupabaseClient(accessToken);
    const { data, error } = await client
        .from("businesses")
        .insert({
            organization_id: organizationId,
            legal_name: input.legalName,
            dba_name: input.dbaName ?? null
        })
        .select(safeBusinessColumns)
        .single();

    if (error || !data) {
        throw new BusinessServiceError("BUSINESS_CREATE_FAILED");
    }

    return projectBusinessRow(data);
};

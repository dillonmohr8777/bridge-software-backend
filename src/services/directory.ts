import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createPublicSupabaseClient, createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { CreateDirectoryInput, DirectoryQuery, UpdateDirectoryInput } from "../schemas/directory.js";
import type { ApplicationIdentity } from "../types/application-identity.js";

const rowSchema = z.object({
    id: z.uuid(), slug: z.string(), role: z.enum(["brand", "retailer", "dispensary", "sales_rep"]),
    name: z.string(), company_name: z.string(), description: z.string(), location: z.string(), state: z.string(),
    service_territories: z.array(z.string()), products: z.array(z.string()), categories: z.array(z.string()),
    logo_url: z.string().nullable(), visibility: z.enum(["private", "public"]), verified: z.boolean(),
    created_at: z.string(), updated_at: z.string()
});
const publicColumns = "id,slug,role,name,company_name,description,location,state,service_territories,products,categories,logo_url,visibility,verified,created_at,updated_at";
export class DirectoryServiceError extends Error {
    constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export const directoryProfileResponse = (input: unknown) => {
    const row = rowSchema.parse(input);
    return {
        id: row.id, slug: row.slug, role: row.role, name: row.name, companyName: row.company_name,
        description: row.description, location: row.location, state: row.state, serviceTerritories: row.service_territories,
        products: row.products, categories: row.categories, logoUrl: row.logo_url, visibility: row.visibility,
        verified: row.verified, verificationStatus: row.verified ? "verified" as const : "pending" as const,
        createdAt: row.created_at, updatedAt: row.updated_at
    };
};
export const canManageDirectory = (identity: ApplicationIdentity, owner: { organization_id: string | null; owner_user_id: string | null }) =>
    owner.organization_id !== null
        ? identity.memberships.some(m => m.organizationId === owner.organization_id && m.status === "active" && (m.role === "owner" || m.role === "admin"))
        : identity.accountType === "sales_rep" && owner.owner_user_id === identity.userId;

// Escape LIKE wildcards; filter values are passed as a single SDK argument.
export const directorySearchPattern = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&").replace(/\*/g, " ")}%`;
export const listDirectory = async (query: DirectoryQuery, client = createPublicSupabaseClient()) => {
    let request = client.from("directory_profile_read").select(publicColumns, { count: "exact" }).eq("visibility", "public");
    if (query.role) request = request.eq("role", query.role);
    if (query.state) request = request.eq("state", query.state);
    if (query.territory) request = request.contains("service_territories", [query.territory]);
    if (query.category) request = request.contains("categories", [query.category]);
    if (query.product) request = request.contains("products", [query.product]);
    if (query.verified !== undefined) request = request.eq("verified", query.verified);
    if (query.query) request = request.ilike("search_text", directorySearchPattern(query.query));
    const start = (query.page - 1) * query.pageSize;
    const { data, error, count } = await request.order("name").order("id").range(start, start + query.pageSize - 1);
    if (error) throw new DirectoryServiceError(503, "DIRECTORY_UNAVAILABLE");
    return { profiles: (data ?? []).map(directoryProfileResponse), pagination: { page: query.page, pageSize: query.pageSize, total: count ?? 0, totalPages: Math.ceil((count ?? 0) / query.pageSize) } };
};
export const getDirectoryProfile = async (identifier: string, client = createPublicSupabaseClient(), publicOnly = true) => {
    let request = client.from("directory_profile_read").select(publicColumns).eq(z.uuid().safeParse(identifier).success ? "id" : "slug", identifier);
    if (publicOnly) request = request.eq("visibility", "public");
    const { data, error } = await request.maybeSingle();
    if (error) throw new DirectoryServiceError(503, "DIRECTORY_UNAVAILABLE");
    if (!data) throw new DirectoryServiceError(404, "DIRECTORY_NOT_FOUND");
    return directoryProfileResponse(data);
};
export const listOwnDirectory = async (accessToken: string, client = createUserScopedSupabaseClient(accessToken)) => {
    const { data, error } = await client.from("directory_profiles").select("id").order("created_at");
    if (error) throw new DirectoryServiceError(503, "DIRECTORY_UNAVAILABLE");
    const ids = (data ?? []).map(row => row.id as string);
    if (ids.length === 0) return { profiles: [] };
    const result = await client.from("directory_profile_read").select(publicColumns).in("id", ids).order("name").order("id");
    if (result.error) throw new DirectoryServiceError(503, "DIRECTORY_UNAVAILABLE");
    return { profiles: (result.data ?? []).map(directoryProfileResponse) };
};
const databaseChanges = (input: UpdateDirectoryInput) => {
    const { companyName, serviceTerritories, logoUrl, ...rest } = input;
    return { ...rest, ...(companyName !== undefined ? { company_name: companyName } : {}), ...(serviceTerritories !== undefined ? { service_territories: serviceTerritories } : {}), ...(logoUrl !== undefined ? { logo_url: logoUrl } : {}) };
};
const writeFailure = (error: { code?: string }) => {
    if (error.code === "23505") return new DirectoryServiceError(409, "DIRECTORY_CONFLICT");
    if (error.code === "42501") return new DirectoryServiceError(403, "DIRECTORY_FORBIDDEN");
    return new DirectoryServiceError(503, "DIRECTORY_WRITE_FAILED");
};
const assertOrganizationActive = async (client: SupabaseClient, organizationId: string) => {
    const { data, error } = await client.from("organizations").select("id,status,organization_type").eq("id", organizationId).maybeSingle();
    if (error) throw new DirectoryServiceError(503, "DIRECTORY_UNAVAILABLE");
    if (!data || data.status !== "active" || !data.organization_type) throw new DirectoryServiceError(403, "DIRECTORY_FORBIDDEN");
};
export const createDirectoryProfile = async (accessToken: string, identity: ApplicationIdentity, input: CreateDirectoryInput, client = createUserScopedSupabaseClient(accessToken)) => {
    const { organizationId, ...fields } = input;
    const owner = { organization_id: organizationId ?? null, owner_user_id: organizationId ? null : identity.userId };
    if (!canManageDirectory(identity, owner)) throw new DirectoryServiceError(403, "DIRECTORY_FORBIDDEN");
    if (organizationId) await assertOrganizationActive(client, organizationId);
    const { data, error } = await client.from("directory_profiles").insert({ ...owner, ...databaseChanges(fields) }).select("id").single();
    if (error) throw writeFailure(error);
    if (!data) throw new DirectoryServiceError(503, "DIRECTORY_WRITE_FAILED");
    return getDirectoryProfile(data.id as string, client, false);
};
export const updateDirectoryProfile = async (accessToken: string, identity: ApplicationIdentity, id: string, input: UpdateDirectoryInput, client = createUserScopedSupabaseClient(accessToken)) => {
    const { data: owner, error: readError } = await client.from("directory_profiles").select("organization_id,owner_user_id").eq("id", id).maybeSingle();
    if (readError) throw new DirectoryServiceError(503, "DIRECTORY_UNAVAILABLE");
    if (!owner) throw new DirectoryServiceError(404, "DIRECTORY_NOT_FOUND");
    if (!canManageDirectory(identity, owner as { organization_id: string | null; owner_user_id: string | null })) throw new DirectoryServiceError(403, "DIRECTORY_FORBIDDEN");
    if (owner.organization_id) await assertOrganizationActive(client, owner.organization_id as string);
    const { data, error } = await client.from("directory_profiles").update(databaseChanges(input)).eq("id", id).select("id").maybeSingle();
    if (error) throw writeFailure(error);
    if (!data) throw new DirectoryServiceError(404, "DIRECTORY_NOT_FOUND");
    return getDirectoryProfile(id, client, false);
};


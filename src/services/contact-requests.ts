import { z } from "zod";

import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type {
    ContactRequestListQuery,
    ContactRequestTransitionInput,
    CreateContactRequestInput,
    SentContactRequestListQuery
} from "../schemas/contact-requests.js";

const statusSchema = z.enum(["new", "viewed", "responded", "closed"]);
const routingStatusSchema = z.enum(["routed", "needs_assignment"]);
const createResultSchema = z.object({
    request_id: z.uuid(),
    request_status: statusSchema,
    routing_status: routingStatusSchema,
    created_at: z.string()
});
const inboundRowSchema = z.object({
    request_id: z.uuid(), request_status: statusSchema,
    routing_status: routingStatusSchema,
    first_name: z.string(), work_email: z.string(), phone_number: z.string(),
    years_of_service: z.number(), contact_preference: z.enum(["email", "phone", "either"]),
    message: z.string().nullable(), created_at: z.string(), updated_at: z.string()
});
const sentRowSchema = z.object({
    request_id: z.uuid(), target_slug: z.string(), target_display_name: z.string(),
    request_status: statusSchema, created_at: z.string(), updated_at: z.string()
});
const transitionResultSchema = z.object({
    request_id: z.uuid(), request_status: statusSchema, updated_at: z.string()
});

export type ContactRequestErrorCode =
    | "CONTACT_REQUEST_NOT_FOUND"
    | "CONTACT_REQUEST_INELIGIBLE"
    | "CONTACT_REQUEST_INVALID_TRANSITION"
    | "CONTACT_REQUEST_FAILED";

export class ContactRequestServiceError extends Error {
    constructor(public readonly code: ContactRequestErrorCode) {
        super(code);
        this.name = "ContactRequestServiceError";
    }
}

const mapRpcError = (error: { code?: string; message?: string }): never => {
    if (error.code === "P0002") {
        throw new ContactRequestServiceError("CONTACT_REQUEST_NOT_FOUND");
    }
    if (error.code === "55000") {
        throw new ContactRequestServiceError(
            error.message?.toLowerCase().includes("transition")
                ? "CONTACT_REQUEST_INVALID_TRANSITION"
                : "CONTACT_REQUEST_INELIGIBLE"
        );
    }
    throw new ContactRequestServiceError("CONTACT_REQUEST_FAILED");
};

export const createContactRequest = async (
    accessToken: string,
    slug: string,
    input: CreateContactRequestInput
) => {
    const { data, error } = await createUserScopedSupabaseClient(accessToken)
        .rpc("create_contact_request", {
            p_target_slug: slug,
            p_first_name: input.firstName,
            p_work_email: input.workEmail,
            p_phone_number: input.phoneNumber,
            p_years_of_service: input.yearsOfService,
            p_contact_preference: input.contactPreference,
            p_message: input.message ?? null
        }).single();
    if (error) return mapRpcError(error);
    const parsed = createResultSchema.safeParse(data);
    if (!parsed.success) throw new ContactRequestServiceError("CONTACT_REQUEST_FAILED");
    return {
        request: {
            id: parsed.data.request_id,
            status: parsed.data.request_status,
            routingStatus: parsed.data.routing_status,
            createdAt: parsed.data.created_at
        }
    };
};

export const listInboundContactRequests = async (
    accessToken: string,
    organizationId: string,
    query: ContactRequestListQuery
) => {
    const { data, error } = await createUserScopedSupabaseClient(accessToken)
        .rpc("list_inbound_contact_requests", {
            p_organization_id: organizationId,
            p_status: query.status ?? null,
            p_limit: query.limit + 1,
            p_offset: query.offset
        });
    if (error) return mapRpcError(error);
    const parsed = z.array(inboundRowSchema).safeParse(data ?? []);
    if (!parsed.success) throw new ContactRequestServiceError("CONTACT_REQUEST_FAILED");
    const hasMore = parsed.data.length > query.limit;
    return { requests: parsed.data.slice(0, query.limit).map((row) => ({
        id: row.request_id, status: row.request_status,
        routingStatus: row.routing_status, firstName: row.first_name,
        workEmail: row.work_email, phoneNumber: row.phone_number,
        yearsOfService: row.years_of_service,
        contactPreference: row.contact_preference, message: row.message,
        createdAt: row.created_at, updatedAt: row.updated_at
    })), pageInfo: { limit: query.limit, offset: query.offset, hasMore } };
};

export const listSentContactRequests = async (
    accessToken: string,
    query: SentContactRequestListQuery
) => {
    const { data, error } = await createUserScopedSupabaseClient(accessToken)
        .rpc("list_sent_contact_requests", {
            p_limit: query.limit + 1,
            p_offset: query.offset
        });
    if (error) return mapRpcError(error);
    const parsed = z.array(sentRowSchema).safeParse(data ?? []);
    if (!parsed.success) throw new ContactRequestServiceError("CONTACT_REQUEST_FAILED");
    const hasMore = parsed.data.length > query.limit;
    return { requests: parsed.data.slice(0, query.limit).map((row) => ({
        id: row.request_id,
        target: { slug: row.target_slug, displayName: row.target_display_name },
        status: row.request_status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    })), pageInfo: { limit: query.limit, offset: query.offset, hasMore } };
};

export const transitionContactRequest = async (
    accessToken: string,
    organizationId: string,
    requestId: string,
    input: ContactRequestTransitionInput
) => {
    const { data, error } = await createUserScopedSupabaseClient(accessToken)
        .rpc("transition_contact_request", {
            p_organization_id: organizationId,
            p_request_id: requestId,
            p_status: input.status
        }).single();
    if (error) return mapRpcError(error);
    const parsed = transitionResultSchema.safeParse(data);
    if (!parsed.success) throw new ContactRequestServiceError("CONTACT_REQUEST_FAILED");
    return { request: {
        id: parsed.data.request_id,
        status: parsed.data.request_status,
        updatedAt: parsed.data.updated_at
    } };
};

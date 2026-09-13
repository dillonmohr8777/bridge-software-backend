import { z } from "zod";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import { dispatchDirectoryEmails, isDirectoryEmailConfigured } from "./directory-email.js";
import type { CreateDirectoryRequest, DirectoryRequestsQuery } from "../schemas/directory-requests.js";
export class DirectoryRequestError extends Error {
    constructor(public readonly status: number, public readonly code: string) { super(code); }
}
const fail = (error: { code?: string } | null) => {
    if (!error) return;
    const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : error.code === "23505" ? 409 : error.code === "22023" ? 400 : 503;
    throw new DirectoryRequestError(status, status === 409 ? "DIRECTORY_REQUEST_CONFLICT" : status === 404 ? "DIRECTORY_REQUEST_NOT_FOUND" : status === 403 ? "DIRECTORY_REQUEST_FORBIDDEN" : status === 400 ? "VALIDATION_ERROR" : "DIRECTORY_REQUEST_UNAVAILABLE");
};
const columns = "id,profile_id,kind,message,reply_email,status,created_at,updated_at,can_review,email_delivery";
const rowSchema = z.object({
    id: z.uuid(), profile_id: z.uuid(), kind: z.enum(["contact", "claim", "correction"]), message: z.string(),
    reply_email: z.string().nullable(), status: z.enum(["pending", "resolved", "rejected"]),
    created_at: z.string(), updated_at: z.string(), can_review: z.boolean(),
    email_delivery: z.enum(["not_applicable", "queued", "sent", "partial", "failed"]).default("not_applicable")
});
export const directoryRequestResponse = (input: unknown) => {
    const row = rowSchema.parse(input);
    return { id: row.id, profileId: row.profile_id, kind: row.kind, message: row.message, replyEmail: row.reply_email,
        status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, canReview: row.can_review,
        emailDelivery: isDirectoryEmailConfigured() ? row.email_delivery : "not_configured" as const };
};
export const getDirectoryRequest = async (token: string, id: string, client = createUserScopedSupabaseClient(token)) => {
    const { data, error } = await client.from("directory_request_read").select(columns).eq("id", id).maybeSingle();
    fail(error);
    if (!data) throw new DirectoryRequestError(404, "DIRECTORY_REQUEST_NOT_FOUND");
    return directoryRequestResponse(data);
};
export const listDirectoryRequests = async (token: string, query: DirectoryRequestsQuery, client = createUserScopedSupabaseClient(token)) => {
    let request = client.from("directory_request_read").select(columns, { count: "exact" });
    if (query.kind) request = request.eq("kind", query.kind);
    if (query.status) request = request.eq("status", query.status);
    const start = (query.page - 1) * query.pageSize;
    const { data, error, count } = await request.order("created_at", { ascending: false }).order("id", { ascending: false }).range(start, start + query.pageSize - 1);
    fail(error);
    return { requests: (data ?? []).map(directoryRequestResponse), pagination: { page: query.page, pageSize: query.pageSize, total: count ?? 0, totalPages: Math.ceil((count ?? 0) / query.pageSize) } };
};
export const submitDirectoryRequest = async (token: string, input: CreateDirectoryRequest, client = createUserScopedSupabaseClient(token)) => {
    const { data, error } = await client.rpc("submit_directory_request", { p_profile_id: input.profileId, p_kind: input.kind, p_message: input.message, p_share_email: input.shareEmail, p_idempotency_key: input.idempotencyKey });
    fail(error);
    const id = z.uuid().parse(data);
    await dispatchDirectoryEmails(id).catch((emailError) =>
        console.error("Directory email dispatch failed", emailError)
    );
    return getDirectoryRequest(token, id, client);
};
export const reviewDirectoryRequest = async (token: string, id: string, status: "resolved" | "rejected", client = createUserScopedSupabaseClient(token)) => {
    const { data, error } = await client.rpc("review_directory_request", { p_request_id: id, p_status: status });
    fail(error);
    const requestId = z.uuid().parse(data);
    await dispatchDirectoryEmails(requestId).catch((emailError) =>
        console.error("Directory email dispatch failed", emailError)
    );
    return getDirectoryRequest(token, requestId, client);
};

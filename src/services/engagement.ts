import { z } from "zod";
import { createPublicSupabaseClient, createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { ApplicationIdentity } from "../types/application-identity.js";
import type { CreatePostInput, UpdatePostInput, PostsQuery, EngagementPage } from "../schemas/engagement.js";
import { canManageDirectory } from "./directory.js";

export class EngagementServiceError extends Error {
    constructor(public readonly status: number, public readonly code: string) { super(code); }
}
const fail = (error: { code?: string } | null) => {
    if (error) throw new EngagementServiceError(error.code === "42501" ? 403 : 503, error.code === "42501" ? "ENGAGEMENT_FORBIDDEN" : "ENGAGEMENT_UNAVAILABLE");
};
const postColumns = "id,profile_id,type,title,body,status,created_at,updated_at";
const postRow = z.object({ id: z.uuid(), profile_id: z.uuid(), type: z.enum(["announcement", "news"]), title: z.string(), body: z.string(), status: z.enum(["draft", "published"]), created_at: z.string(), updated_at: z.string() });
export const postResponse = (input: unknown) => {
    const row = postRow.parse(input);
    return { id: row.id, profileId: row.profile_id, type: row.type, title: row.title, body: row.body, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
};
const pagination = (query: EngagementPage, count: number | null) => ({ ...query, total: count ?? 0, totalPages: Math.ceil((count ?? 0) / query.pageSize) });
export const listPosts = async (query: PostsQuery, client = createPublicSupabaseClient(), own = false) => {
    let request = client.from(own ? "engagement_posts" : "engagement_public_posts").select(postColumns, { count: "exact" });
    if (query.profileId) request = request.eq("profile_id", query.profileId);
    const offset = (query.page - 1) * query.pageSize;
    const { data, error, count } = await request.order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + query.pageSize - 1);
    fail(error);
    return { posts: (data ?? []).map(postResponse), pagination: pagination({ page: query.page, pageSize: query.pageSize }, count) };
};
const assertManageProfile = async (client: ReturnType<typeof createUserScopedSupabaseClient>, identity: ApplicationIdentity, profileId: string, publishing: boolean) => {
    const { data: owner, error } = await client.from("directory_profiles").select("organization_id,owner_user_id").eq("id", profileId).maybeSingle();
    fail(error);
    if (!owner) throw new EngagementServiceError(404, "PROFILE_NOT_FOUND");
    if (!canManageDirectory(identity, owner)) throw new EngagementServiceError(403, "ENGAGEMENT_FORBIDDEN");
    if (owner.organization_id) {
        const organization = await client.from("organizations").select("status").eq("id", owner.organization_id).maybeSingle();
        fail(organization.error);
        if (organization.data?.status !== "active") throw new EngagementServiceError(403, "ENGAGEMENT_FORBIDDEN");
    }
    if (publishing) {
        const profile = await client.from("directory_profile_read").select("id").eq("id", profileId).eq("visibility", "public").eq("verified", true).maybeSingle();
        fail(profile.error);
        if (!profile.data) throw new EngagementServiceError(403, "VERIFIED_PUBLIC_PROFILE_REQUIRED");
    }
};
export const createPost = async (token: string, identity: ApplicationIdentity, input: CreatePostInput, client = createUserScopedSupabaseClient(token)) => {
    await assertManageProfile(client, identity, input.profileId, input.status === "published");
    const { profileId, ...fields } = input;
    const { data, error } = await client.from("engagement_posts").insert({ ...fields, profile_id: profileId }).select(postColumns).single();
    fail(error);
    return postResponse(data);
};
export const updatePost = async (token: string, identity: ApplicationIdentity, id: string, input: UpdatePostInput, client = createUserScopedSupabaseClient(token)) => {
    const existing = await client.from("engagement_posts").select("profile_id,status").eq("id", id).maybeSingle();
    fail(existing.error);
    if (!existing.data) throw new EngagementServiceError(404, "POST_NOT_FOUND");
    await assertManageProfile(client, identity, existing.data.profile_id, (input.status ?? existing.data.status) === "published");
    const { data, error } = await client.from("engagement_posts").update(input).eq("id", id).select(postColumns).maybeSingle();
    fail(error);
    if (!data) throw new EngagementServiceError(404, "POST_NOT_FOUND");
    return postResponse(data);
};
export const isSavedProfile = async (token: string, profileId: string, client = createUserScopedSupabaseClient(token)) => {
    const { data, error } = await client.from("engagement_saved_profile_read").select("profile_id").eq("profile_id", profileId).maybeSingle();
    fail(error);
    return { saved: data !== null };
};
export const setSavedProfile = async (token: string, userId: string, profileId: string, saved: boolean, client = createUserScopedSupabaseClient(token)) => {
    if (saved) {
        const profile = await client.from("directory_profile_read").select("id").eq("id", profileId).eq("visibility", "public").maybeSingle();
        fail(profile.error);
        if (!profile.data) throw new EngagementServiceError(404, "PROFILE_NOT_FOUND");
        const result = await client.from("engagement_saved_profiles").upsert({ user_id: userId, profile_id: profileId }, { onConflict: "user_id,profile_id", ignoreDuplicates: true });
        fail(result.error);
    } else {
        const result = await client.from("engagement_saved_profiles").delete().eq("user_id", userId).eq("profile_id", profileId);
        fail(result.error);
    }
    return { saved };
};
export const listSavedProfiles = async (token: string, query: EngagementPage, client = createUserScopedSupabaseClient(token)) => {
    const offset = (query.page - 1) * query.pageSize;
    const { data, error, count } = await client.from("engagement_saved_profile_read").select("profile_id,saved_at", { count: "exact" }).order("saved_at", { ascending: false }).order("profile_id").range(offset, offset + query.pageSize - 1);
    fail(error);
    return { savedProfiles: (data ?? []).map(row => ({ profileId: row.profile_id, savedAt: row.saved_at })), pagination: pagination(query, count) };
};
const notificationColumns = "id,type,title,body,created_at,read_at";
export const notificationResponse = (row: Record<string, unknown>) => ({ id: row.id, type: row.type, title: row.title, body: row.body, createdAt: row.created_at, readAt: row.read_at });
export const listNotifications = async (token: string, userId: string, query: EngagementPage, client = createUserScopedSupabaseClient(token)) => {
    const offset = (query.page - 1) * query.pageSize;
    const { data, error, count } = await client.from("engagement_notifications").select(notificationColumns, { count: "exact" }).eq("user_id", userId).order("created_at", { ascending: false }).order("id").range(offset, offset + query.pageSize - 1);
    fail(error);
    return { notifications: (data ?? []).map(notificationResponse), pagination: pagination(query, count) };
};
export const markNotificationRead = async (token: string, userId: string, id: string, client = createUserScopedSupabaseClient(token)) => {
    const result = await client.from("engagement_notifications").update({ read_at: new Date().toISOString() }).eq("user_id", userId).eq("id", id).is("read_at", null);
    fail(result.error);
    const { data, error } = await client.from("engagement_notifications").select(notificationColumns).eq("user_id", userId).eq("id", id).maybeSingle();
    fail(error);
    if (!data) throw new EngagementServiceError(404, "NOTIFICATION_NOT_FOUND");
    return notificationResponse(data);
};

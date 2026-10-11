import type { User } from "@supabase/supabase-js";
import { z } from "zod";

import { env } from "../config/index.js";
import {
    createAdminSupabaseClient,
    SupabaseAdminNotConfiguredError
} from "../lib/supabase.js";
import type {
    AdminUserInvitationInput,
    AdminUsersQuery
} from "../schemas/admin-users.js";

const profileRowSchema = z.object({
    id: z.uuid(),
    display_name: z.string().nullable(),
    account_type: z.enum(["standard", "sales_rep"])
});

const platformRoleRowSchema = z.object({
    user_id: z.uuid(),
    role: z.literal("admin")
});

const membershipRowSchema = z.object({
    user_id: z.uuid(),
    organization_id: z.uuid(),
    role: z.enum(["owner", "admin", "reviewer", "member"]),
    status: z.literal("active"),
    organizations: z.object({
        id: z.uuid(),
        name: z.string()
    })
});

export type AdminUserFailureCode =
    | "ADMIN_USER_ALREADY_EXISTS"
    | "ADMIN_USER_INVITATION_FAILED"
    | "ADMIN_USERS_UNAVAILABLE"
    | "INTERNAL_SERVER_ERROR";

export class AdminUserServiceError extends Error {
    constructor(public readonly code: AdminUserFailureCode) {
        super(code);
        this.name = "AdminUserServiceError";
    }
}

type ProfileRow = z.infer<typeof profileRowSchema>;
type PlatformRoleRow = z.infer<typeof platformRoleRowSchema>;
type MembershipRow = z.infer<typeof membershipRowSchema>;

export const combineAdminUserData = (
    authUsers: User[],
    profiles: ProfileRow[],
    platformRoles: PlatformRoleRow[],
    memberships: MembershipRow[]
) => {
    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
    const platformAdmins = new Set(
        platformRoles.map((role) => role.user_id)
    );
    const membershipsByUser = new Map<string, MembershipRow[]>();

    for (const membership of memberships) {
        const existing = membershipsByUser.get(membership.user_id) ?? [];
        existing.push(membership);
        membershipsByUser.set(membership.user_id, existing);
    }

    // Iterate auth users exactly once; one-to-many membership rows cannot
    // duplicate the top-level user projection.
    return authUsers.map((user) => {
        const profile = profilesById.get(user.id);
        return {
            id: user.id,
            email: user.email ?? null,
            displayName: profile?.display_name ?? null,
            emailVerified: user.email_confirmed_at != null,
            createdAt: user.created_at,
            lastSignInAt: user.last_sign_in_at ?? null,
            accountType: profile?.account_type ?? null,
            platformRole: platformAdmins.has(user.id) ? "admin" as const : null,
            organizationMemberships: (membershipsByUser.get(user.id) ?? []).map(
                (membership) => ({
                    organizationId: membership.organization_id,
                    organizationName: membership.organizations.name,
                    role: membership.role
                })
            )
        };
    });
};

const getAdminClient = () => {
    try {
        return createAdminSupabaseClient();
    } catch (error) {
        if (error instanceof SupabaseAdminNotConfiguredError) {
            throw new AdminUserServiceError("ADMIN_USERS_UNAVAILABLE");
        }
        throw new AdminUserServiceError("INTERNAL_SERVER_ERROR");
    }
};

type AdminAuthFailure = {
    code?: string | undefined;
    message?: string | undefined;
};

const isDuplicateInvitation = (error: AdminAuthFailure): boolean => {
    const code = error.code?.toLowerCase();
    const message = error.message?.toLowerCase() ?? "";
    return (
        code === "email_exists" ||
        code === "user_already_exists" ||
        code === "identity_already_exists" ||
        message.includes("already been registered") ||
        message.includes("already exists")
    );
};

export const inviteAdminUser = async (
    actorUserId: string,
    input: AdminUserInvitationInput
) => {
    const client = getAdminClient();
    let invitedUserId: string | undefined;

    try {
        const { data: invitationData, error: invitationError } =
            await client.auth.admin.inviteUserByEmail(input.email, {
                redirectTo: env.EMAIL_VERIFICATION_REDIRECT_URL,
                data: { display_name: input.displayName }
            });

        if (invitationError) {
            if (isDuplicateInvitation(invitationError)) {
                throw new AdminUserServiceError("ADMIN_USER_ALREADY_EXISTS");
            }
            throw new AdminUserServiceError("ADMIN_USERS_UNAVAILABLE");
        }
        if (!invitationData.user) {
            throw new AdminUserServiceError("ADMIN_USERS_UNAVAILABLE");
        }

        invitedUserId = invitationData.user.id;
        const profileResult = await client
            .from("user_profiles")
            .update({
                display_name: input.displayName,
                account_type: input.accountType
            })
            .eq("id", invitedUserId)
            .select("id")
            .maybeSingle();

        if (profileResult.error || !profileResult.data) {
            throw new AdminUserServiceError("ADMIN_USER_INVITATION_FAILED");
        }

        if (input.platformRole === "admin") {
            const { error: roleError } = await client
                .from("user_platform_roles")
                .upsert(
                    { user_id: invitedUserId, role: "admin" },
                    { onConflict: "user_id,role" }
                );
            if (roleError) {
                throw new AdminUserServiceError("ADMIN_USER_INVITATION_FAILED");
            }
        }

        const { error: auditError } = await client.from("audit_logs").insert({
            actor_user_id: actorUserId,
            action: "create",
            entity_type: "user_invitation",
            entity_id: invitedUserId,
            metadata: {
                account_type: input.accountType,
                platform_role: input.platformRole ?? null
            }
        });
        if (auditError) {
            throw new AdminUserServiceError("ADMIN_USER_INVITATION_FAILED");
        }

        return {
            id: invitedUserId,
            email: input.email,
            displayName: input.displayName,
            accountType: input.accountType,
            platformRole: input.platformRole ?? null,
            invitationSent: true as const
        };
    } catch (error) {
        if (invitedUserId) {
            try {
                await client.auth.admin.deleteUser(invitedUserId);
            } catch {
                // The original failure is more actionable; never expose provider details.
            }
        }

        if (error instanceof AdminUserServiceError) {
            throw error;
        }
        throw new AdminUserServiceError(
            invitedUserId
                ? "ADMIN_USER_INVITATION_FAILED"
                : "ADMIN_USERS_UNAVAILABLE"
        );
    }
};

export const listAdminUsers = async (query: AdminUsersQuery) => {
    const client = getAdminClient();
    const { data: authData, error: authError } =
        await client.auth.admin.listUsers({
            page: query.page,
            perPage: query.pageSize
        });

    if (authError) {
        console.warn("Supabase admin user listing failed", {
            operation: "admin-list-users",
            providerCode: authError.code ?? "unknown",
            status: authError.status ?? "unknown"
        });
        throw new AdminUserServiceError("ADMIN_USERS_UNAVAILABLE");
    }

    const userIds = authData.users.map((user) => user.id);
    if (userIds.length === 0) {
        return {
            users: [],
            pagination: {
                page: query.page,
                pageSize: query.pageSize,
                total: authData.total
            }
        };
    }

    const [profilesResult, rolesResult, membershipsResult] = await Promise.all([
        client
            .from("user_profiles")
            .select("id, display_name, account_type")
            .in("id", userIds),
        client
            .from("user_platform_roles")
            .select("user_id, role")
            .in("user_id", userIds),
        client
            .from("organization_members")
            .select("user_id, organization_id, role, status, organizations!inner(id, name)")
            .in("user_id", userIds)
            .eq("status", "active")
    ]);

    if (profilesResult.error || rolesResult.error || membershipsResult.error) {
        throw new AdminUserServiceError("ADMIN_USERS_UNAVAILABLE");
    }

    const profiles = z.array(profileRowSchema).safeParse(profilesResult.data);
    const roles = z.array(platformRoleRowSchema).safeParse(rolesResult.data);
    const memberships = z
        .array(membershipRowSchema)
        .safeParse(membershipsResult.data);

    if (!profiles.success || !roles.success || !memberships.success) {
        throw new AdminUserServiceError("INTERNAL_SERVER_ERROR");
    }

    return {
        users: combineAdminUserData(
            authData.users,
            profiles.data,
            roles.data,
            memberships.data
        ),
        pagination: {
            page: query.page,
            pageSize: query.pageSize,
            total: authData.total
        }
    };
};

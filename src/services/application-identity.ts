import type { User } from "@supabase/supabase-js";
import { z } from "zod";

import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { ApplicationIdentity } from "../types/application-identity.js";

const profileSchema = z.object({
    display_name: z.string().nullable(),
    phone: z.string().nullable(),
    account_type: z.enum(["standard", "sales_rep"])
});

const platformRoleSchema = z.object({
    role: z.enum(["admin"])
});

const membershipSchema = z.object({
    organization_id: z.uuid(),
    role: z.enum(["owner", "admin", "page_manager", "reviewer", "member"]),
    status: z.literal("active"),
    organizations: z.object({
        id: z.uuid(),
        name: z.string(),
        organization_type: z
            .enum(["brand", "retailer", "dispensary"])
            .nullable()
    })
});

export class ApplicationIdentityResolutionError extends Error {
    constructor() {
        super("Application identity could not be resolved.");
        this.name = "ApplicationIdentityResolutionError";
    }
}

export const resolveApplicationIdentity = async (
    user: User,
    accessToken: string
): Promise<ApplicationIdentity> => {
    const client = createUserScopedSupabaseClient(accessToken);

    const [profileResult, membershipsResult, platformRolesResult] =
        await Promise.all([
        client
            .from("user_profiles")
            .select("display_name, phone, account_type")
            .eq("id", user.id)
            .maybeSingle(),
        client
            .from("organization_members")
            .select(
                "organization_id, role, status, organizations!inner(id, name, organization_type)"
            )
            .eq("user_id", user.id)
            .eq("status", "active"),
        client
            .from("user_platform_roles")
            .select("role")
            .eq("user_id", user.id)
    ]);

    if (
        profileResult.error ||
        membershipsResult.error ||
        platformRolesResult.error
    ) {
        throw new ApplicationIdentityResolutionError();
    }

    const parsedProfile = profileResult.data
        ? profileSchema.safeParse(profileResult.data)
        : null;
    const parsedMemberships = z
        .array(membershipSchema)
        .safeParse(membershipsResult.data);
    const parsedPlatformRoles = z
        .array(platformRoleSchema)
        .safeParse(platformRolesResult.data);

    if (
        (parsedProfile && !parsedProfile.success) ||
        !parsedMemberships.success ||
        !parsedPlatformRoles.success
    ) {
        throw new ApplicationIdentityResolutionError();
    }

    return {
        userId: user.id,
        email: user.email ?? null,
        accountType: parsedProfile ? parsedProfile.data.account_type : null,
        platformRoles: parsedPlatformRoles.data.map(({ role }) => role),
        profile: parsedProfile
            ? {
                  displayName: parsedProfile.data.display_name,
                  phone: parsedProfile.data.phone
              }
            : null,
        memberships: parsedMemberships.data.map((membership) => ({
            organizationId: membership.organization_id,
            organizationName: membership.organizations.name,
            organizationType:
                membership.organizations.organization_type,
            role: membership.role,
            status: membership.status
        }))
    };
};

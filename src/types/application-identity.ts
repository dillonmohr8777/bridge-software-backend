export type OrganizationRole =
    | "owner"
    | "admin"
    | "page_manager"
    | "reviewer"
    | "member";

export type OrganizationType = "brand" | "retailer" | "dispensary";

export type UserAccountType = "standard" | "sales_rep";

export type PlatformRole = "admin";

export type MembershipStatus =
    | "active"
    | "invited"
    | "suspended"
    | "removed";

export interface ApplicationProfile {
    displayName: string | null;
    phone: string | null;
}

export interface ApplicationMembership {
    organizationId: string;
    organizationName: string;
    organizationType: OrganizationType | null;
    role: OrganizationRole;
    status: MembershipStatus;
}

export interface ApplicationIdentity {
    userId: string;
    email: string | null;
    accountType: UserAccountType | null;
    platformRoles: PlatformRole[];
    profile: ApplicationProfile | null;
    memberships: ApplicationMembership[];
}

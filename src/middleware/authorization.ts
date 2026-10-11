import type { Request, RequestHandler } from "express";

import type {
    ApplicationIdentity,
    OrganizationRole
} from "../types/application-identity.js";

export const PERMISSIONS = [
    "organization:read",
    "organization:update",
    "organization:members_manage",
    "business:read",
    "business:update",
    "directory_profile:content_update",
    "verification:read",
    "verification:submit",
    "verification:review",
    "document:read",
    "document:upload",
    "document:review",
    "audit:read",
    "contact_request:read",
    "contact_request:update",
    "admin:verification_queue",
    "admin:verification_review",
    "admin:directory_review",
    "admin:users_read",
    "admin:users_write",
    "ein:reveal"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const rolePermissions: Record<OrganizationRole, ReadonlySet<Permission>> = {
    owner: new Set([
        "organization:read", "organization:update",
        "organization:members_manage", "business:read", "business:update",
        "verification:read", "verification:submit", "verification:review",
        "document:read", "document:upload", "document:review", "audit:read",
        "contact_request:read", "contact_request:update",
        "directory_profile:content_update"
    ]),
    admin: new Set([
        "organization:read", "organization:update",
        "organization:members_manage", "business:read", "business:update",
        "verification:read", "verification:submit", "verification:review",
        "document:read", "document:upload", "document:review", "audit:read",
        "contact_request:read", "contact_request:update",
        "directory_profile:content_update"
    ]),
    page_manager: new Set([
        "organization:read", "business:read", "verification:read",
        "document:read", "directory_profile:content_update"
    ]),
    reviewer: new Set([
        "organization:read", "business:read", "verification:read",
        "verification:review", "document:read", "document:review"
    ]),
    member: new Set([
        "organization:read", "business:read", "verification:read",
        "verification:submit", "document:read", "document:upload"
    ])
};

const platformPermissions: ReadonlySet<Permission> = new Set([
    "admin:verification_queue",
    "admin:verification_review",
    "admin:directory_review",
    "admin:users_read",
    "admin:users_write",
    "ein:reveal"
]);

export const hasPermission = (
    identity: ApplicationIdentity,
    permission: Permission,
    organizationId?: string
): boolean => {
    if (platformPermissions.has(permission)) {
        return identity.platformRoles.includes("admin");
    }

    if (!organizationId) {
        return false;
    }

    const membership = identity.memberships.find(
        (candidate) => candidate.organizationId === organizationId
    );

    return membership
        ? rolePermissions[membership.role].has(permission)
        : false;
};

export type OrganizationIdResolver = (req: Request) => string | undefined;

export const requirePermission = (
    permission: Permission,
    resolveOrganizationId?: OrganizationIdResolver
): RequestHandler => {
    return (req, res, next) => {
        if (!req.authentication) {
            res.status(401).json({
                error: "UNAUTHORIZED",
                message: "A valid Bearer access token is required."
            });
            return;
        }

        const organizationId = resolveOrganizationId?.(req);

        if (
            !req.identity ||
            !hasPermission(req.identity, permission, organizationId)
        ) {
            res.status(403).json({
                error: "FORBIDDEN",
                message: "You do not have permission to perform this action."
            });
            return;
        }

        next();
    };
};

export const requireAnyOrganizationPermission = (
    permission: Permission,
    platformPermission?: Permission
): RequestHandler => {
    return (req, res, next) => {
        if (!req.authentication) {
            res.status(401).json({
                error: "UNAUTHORIZED",
                message: "A valid Bearer access token is required."
            });
            return;
        }

        const identity = req.identity;
        const allowed =
            identity !== undefined &&
            ((platformPermission !== undefined &&
                hasPermission(identity, platformPermission)) ||
                identity.memberships.some((membership) =>
                    hasPermission(
                        identity,
                        permission,
                        membership.organizationId
                    )
                ));

        if (!allowed) {
            res.status(403).json({
                error: "FORBIDDEN",
                message: "You do not have permission to perform this action."
            });
            return;
        }

        next();
    };
};

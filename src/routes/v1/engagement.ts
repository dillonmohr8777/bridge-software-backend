import { Router, type RequestHandler } from "express";
import { requireAuthentication } from "../../middleware/authentication.js";
import { loadApplicationIdentity } from "../../middleware/application-identity.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validation.js";
import { createUserScopedSupabaseClient } from "../../lib/supabase.js";
import { engagementIdSchema, engagementPageSchema, postsQuerySchema, createPostSchema, updatePostSchema, markReadSchema } from "../../schemas/engagement.js";
import { EngagementServiceError, listPosts, createPost, updatePost, setSavedProfile, isSavedProfile, listSavedProfiles, listNotifications, markNotificationRead } from "../../services/engagement.js";

const router = Router();
const handle = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
    try { await handler(req, res, next); } catch (error) {
        const failure = error instanceof EngagementServiceError ? error : new EngagementServiceError(500, "INTERNAL_SERVER_ERROR");
        res.status(failure.status).json({ error: failure.code, message: "The engagement request could not be completed." });
    }
};
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
router.get("/posts", validateQuery(postsQuerySchema), handle(async (_req, res) => { res.json(await listPosts(res.locals.validatedQuery)); }));
router.use(requireAuthentication);
router.get("/posts/mine", validateQuery(postsQuerySchema), handle(async (req, res) => {
    res.json(await listPosts(res.locals.validatedQuery, createUserScopedSupabaseClient(req.authentication!.accessToken), true));
}));
router.post("/posts", loadApplicationIdentity, validateBody(createPostSchema), handle(async (req, res) => {
    res.status(201).json({ post: await createPost(req.authentication!.accessToken, req.identity!, req.body) });
}));
router.patch("/posts/:id", loadApplicationIdentity, validateParams(engagementIdSchema), validateBody(updatePostSchema), handle(async (req, res) => {
    res.json({ post: await updatePost(req.authentication!.accessToken, req.identity!, req.params.id as string, req.body) });
}));
router.get("/saved-profiles", validateQuery(engagementPageSchema), handle(async (req, res) => {
    res.json(await listSavedProfiles(req.authentication!.accessToken, res.locals.validatedQuery));
}));
router.get("/saved-profiles/:id", validateParams(engagementIdSchema), handle(async (req, res) => {
    res.json(await isSavedProfile(req.authentication!.accessToken, req.params.id as string));
}));
for (const method of ["put", "delete"] as const) router[method]("/saved-profiles/:id", validateParams(engagementIdSchema), handle(async (req, res) => {
    res.json(await setSavedProfile(req.authentication!.accessToken, req.authentication!.user.id, req.params.id as string, method === "put"));
}));
router.get("/notifications", validateQuery(engagementPageSchema), handle(async (req, res) => {
    res.json(await listNotifications(req.authentication!.accessToken, req.authentication!.user.id, res.locals.validatedQuery));
}));
router.patch("/notifications/:id", validateParams(engagementIdSchema), validateBody(markReadSchema), handle(async (req, res) => {
    res.json({ notification: await markNotificationRead(req.authentication!.accessToken, req.authentication!.user.id, req.params.id as string) });
}));
export { router as engagementRouter };

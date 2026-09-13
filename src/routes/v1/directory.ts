import { Router, type RequestHandler } from "express";
import { requireAuthentication } from "../../middleware/authentication.js";
import { loadApplicationIdentity } from "../../middleware/application-identity.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validation.js";
import { createDirectorySchema, updateDirectorySchema, directoryQuerySchema, directoryIdentifierSchema, directoryIdSchema } from "../../schemas/directory.js";
import { DirectoryServiceError, listDirectory, listOwnDirectory, getDirectoryProfile, createDirectoryProfile, updateDirectoryProfile } from "../../services/directory.js";

const router = Router();
const handle = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
    try { await handler(req, res, next); } catch (error) {
        const failure = error instanceof DirectoryServiceError ? error : new DirectoryServiceError(500, "INTERNAL_SERVER_ERROR");
        res.status(failure.status).json({ error: failure.code, message: "The directory request could not be completed." });
    }
};
router.get("/", validateQuery(directoryQuerySchema), handle(async (_req, res) => {
    res.json(await listDirectory(res.locals.validatedQuery));
}));
router.get("/mine", requireAuthentication, handle(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await listOwnDirectory(req.authentication!.accessToken));
}));
router.post("/", requireAuthentication, loadApplicationIdentity, validateBody(createDirectorySchema), handle(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(201).json({ profile: await createDirectoryProfile(req.authentication!.accessToken, req.identity!, req.body) });
}));
router.patch("/:id", requireAuthentication, loadApplicationIdentity, validateParams(directoryIdSchema), validateBody(updateDirectorySchema), handle(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ profile: await updateDirectoryProfile(req.authentication!.accessToken, req.identity!, req.params.id as string, req.body) });
}));
router.get("/:identifier", validateParams(directoryIdentifierSchema), handle(async (req, res) => {
    res.json({ profile: await getDirectoryProfile(req.params.identifier as string) });
}));
export { router as directoryRouter };

import { Router, type RequestHandler } from "express";
import { requireAuthentication } from "../../middleware/authentication.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validation.js";
import { createDirectoryRequestSchema, reviewDirectoryRequestSchema, directoryRequestIdSchema, directoryRequestsQuerySchema } from "../../schemas/directory-requests.js";
import { DirectoryRequestError, submitDirectoryRequest, reviewDirectoryRequest, listDirectoryRequests, getDirectoryRequest } from "../../services/directory-requests.js";
const router = Router();
const handle = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
    try { await handler(req, res, next); } catch (error) {
        const failure = error instanceof DirectoryRequestError ? error : new DirectoryRequestError(500, "INTERNAL_SERVER_ERROR");
        res.status(failure.status).json({ error: failure.code, message: "The directory request could not be completed." });
    }
};
router.use(requireAuthentication, (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
router.get("/", validateQuery(directoryRequestsQuerySchema), handle(async (req, res) => { res.json(await listDirectoryRequests(req.authentication!.accessToken, res.locals.validatedQuery)); }));
router.get("/:id", validateParams(directoryRequestIdSchema), handle(async (req, res) => { res.json({ request: await getDirectoryRequest(req.authentication!.accessToken, req.params.id as string) }); }));
router.post("/", validateBody(createDirectoryRequestSchema), handle(async (req, res) => { res.status(201).json({ request: await submitDirectoryRequest(req.authentication!.accessToken, req.body) }); }));
router.patch("/:id", validateParams(directoryRequestIdSchema), validateBody(reviewDirectoryRequestSchema), handle(async (req, res) => { res.json({ request: await reviewDirectoryRequest(req.authentication!.accessToken, req.params.id as string, req.body.status) }); }));
export { router as directoryRequestsRouter };

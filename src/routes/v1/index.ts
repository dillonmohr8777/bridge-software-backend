import { Router } from "express";

import { adminVerificationRouter } from "./admin-verification.js";
import { adminDirectoryProfilesRouter } from "./admin-directory-profiles.js";
import { authRouter } from "./auth.js";
import { businessesRouter } from "./businesses.js";
import { contactRequestsRouter } from "./contact-requests.js";
import { directoryProfilesRouter } from "./directory-profiles.js";
import { einRouter } from "./ein.js";
import { notificationsRouter } from "./notifications.js";
import { organizationsRouter } from "./organizations.js";
import { sessionRouter } from "./session.js";
import { systemRouter } from "./system.js";

const router = Router();

router.get("/", (_req, res) => {
    res.status(200).json({
        api: "thebridge",
        version: "v1",
        status: "ok"
    });
});

router.use(systemRouter);
router.use("/auth", authRouter);
router.use("/session", sessionRouter);
router.use("/admin", adminVerificationRouter);
router.use("/admin", adminDirectoryProfilesRouter);
router.use("/organizations", organizationsRouter);
router.use(businessesRouter);
router.use(contactRequestsRouter);
router.use(directoryProfilesRouter);
router.use(einRouter);
router.use(notificationsRouter);

export { router as v1Router };

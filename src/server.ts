import { env } from "./config/index.js";
import { app } from "./app.js";
import { dispatchDirectoryEmails, isDirectoryEmailConfigured } from "./services/directory-email.js";

const port = env.PORT ?? env.API_PORT;

app.listen(port, () => {
    console.log(
        `BRIDGE API listening on port ${port}`
    );
});

if (isDirectoryEmailConfigured()) {
    void dispatchDirectoryEmails().catch((error) => console.error("Directory email drain failed", error));
    setInterval(
        () => void dispatchDirectoryEmails().catch((error) => console.error("Directory email drain failed", error)),
        60_000
    ).unref();
}

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "../config/index.js";
import { createAdminSupabaseClient } from "../lib/supabase.js";

const outboxRowSchema = z.object({
    outbox_id: z.uuid(),
    request_id: z.uuid(),
    event_type: z.enum(["submitted", "reviewed"]),
    recipient_email: z.email(),
    request_kind: z.enum(["contact", "claim", "correction"]),
    request_status: z.enum(["pending", "resolved", "rejected"])
});

export const isDirectoryEmailConfigured = () =>
    Boolean(env.RESEND_API_KEY && env.DIRECTORY_EMAIL_FROM);

const contentFor = (row: z.infer<typeof outboxRowSchema>) => row.event_type === "submitted"
    ? {
        subject: `New Bridge ${row.request_kind} request`,
        text: `A new directory ${row.request_kind} request is ready for review. Sign in to Bridge: ${env.WEB_URL}/requests`
    }
    : {
        subject: "Your Bridge directory request was reviewed",
        text: `Your directory ${row.request_kind} request is now ${row.request_status}. Sign in to Bridge: ${env.WEB_URL}/requests`
    };

export const sendDirectoryEmail = async (
    row: z.infer<typeof outboxRowSchema>,
    fetcher: typeof fetch = fetch
) => {
    const content = contentFor(row);
    const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `bridge-directory/${row.event_type}/${row.outbox_id}`
        },
        body: JSON.stringify({
            from: env.DIRECTORY_EMAIL_FROM,
            to: [row.recipient_email],
            ...(env.DIRECTORY_EMAIL_REPLY_TO ? { reply_to: env.DIRECTORY_EMAIL_REPLY_TO } : {}),
            ...content
        }),
        signal: AbortSignal.timeout(10_000)
    });
    const payload = await response.json().catch(() => ({})) as { id?: unknown; message?: unknown };
    if (!response.ok || typeof payload.id !== "string") {
        throw new Error(typeof payload.message === "string" ? payload.message : `Email provider returned ${response.status}`);
    }
    return payload.id;
};

export const dispatchDirectoryEmails = async (
    requestId?: string,
    client?: SupabaseClient,
    fetcher: typeof fetch = fetch
) => {
    if (!isDirectoryEmailConfigured()) return "not_configured" as const;
    const database = client ?? createAdminSupabaseClient();
    const { data, error } = await database.rpc("claim_directory_email_outbox", {
        p_request_id: requestId ?? null,
        p_limit: 20
    });
    if (error) throw error;

    for (const row of z.array(outboxRowSchema).parse(data ?? [])) {
        try {
            const providerMessageId = await sendDirectoryEmail(row, fetcher);
            const completion = await database.rpc("complete_directory_email_outbox", {
                p_outbox_id: row.outbox_id,
                p_sent: true,
                p_provider_message_id: providerMessageId,
                p_error: null
            });
            if (completion.error) throw completion.error;
        } catch (error) {
            const completion = await database.rpc("complete_directory_email_outbox", {
                p_outbox_id: row.outbox_id,
                p_sent: false,
                p_provider_message_id: null,
                p_error: error instanceof Error ? error.message : "Email provider failed"
            });
            if (completion.error) throw completion.error;
        }
    }
    return "processed" as const;
};

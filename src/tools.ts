import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import type { SharedConfig } from "./config.js";
import { downloadAttachment, getActivity, getGroupStatus, getTask, queryEvents, querySubmissions, queryTasks, searchKnowledge } from "./queries.js";
import { failureText, type Simplepush } from "./simplepush.js";
import { DownloadError, HttpError, type Input } from "@simplepush/sdk";

/** Default block before `send_task` gives up and hands back a task id. Short
 * enough to stay inside every client's tool-call timeout (claude.ai allows 300s;
 * Claude Code auto-backgrounds at 120s), long enough that a human at their phone
 * usually answers within it. */
const DEFAULT_WAIT_SECONDS = 90;

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function describe(err: unknown): string {
  if (err instanceof HttpError) return failureText(err.status, err.body);
  if (err instanceof DownloadError && err.status !== undefined) {
    // The SDK folds the backend body into its message; hand the JSON tail on.
    const body = err.message.slice(err.message.indexOf("{"));
    return failureText(err.status, body.startsWith("{") ? body : "");
  }
  return err instanceof Error ? err.message : String(err);
}

/** How long a client may reuse our `tools/list` / `server/discover` answers.
 *
 * The tool list is fixed at build time — it never varies per user or changes
 * while the process runs — so the only thing that invalidates it is a deploy.
 * That makes the TTL a staleness budget after a release, not a correctness
 * risk: fifteen minutes of chatter saved against fifteen minutes during which
 * a client might not yet see a newly added tool.
 *
 * Kept `private` rather than `public` even though the payload is identical for
 * every caller today. It is served behind a bearer token, and if tools ever get
 * gated by scope the response becomes caller-specific — at which point a shared
 * intermediary holding one user's copy would be a bug rather than a tuning
 * question.
 *
 * Note this TTL is the *only* invalidation path: the SDK advertises
 * `tools.listChanged`, but nothing here ever emits that notification because
 * nothing about the list changes at runtime.
 */
const LIST_CACHE_TTL_MS = 15 * 60 * 1000;

/** The targeting parameters, shaped by mode. Org mode exposes the full org
 * surface (exactly one of topic/member/broadcast, enforced in Simplepush);
 * personal mode keeps the narrow topic-or-self shape, and never advertises
 * parameters the backend would reject anyway. */
function targetFields(sp: Simplepush) {
  // One static shape for both modes — conditional shapes break the SDK's
  // schema-to-JSON conversion (z.undefined() has no JSON Schema form) and the
  // callback's inferred types. The mode difference lives in the descriptions
  // the model reads, and in Simplepush.checkTarget, which turns misuse into a
  // sentence the model can act on.
  return sp.orgMode
    ? {
        topic: z.string().optional().describe("Deliver to this org topic. Exactly one of topic/member/broadcast is required."),
        member: z.string().optional().describe("Deliver to one org member, by name or usr_ id."),
        broadcast: z.boolean().optional().describe("Deliver to every member of the organization."),
      }
    : {
        topic: z.string().optional().describe("Deliver to this topic instead of the user's own devices. Omit for a self-send."),
        member: z.string().optional().describe("Unavailable in personal mode — requires an organization credential."),
        broadcast: z.boolean().optional().describe("Unavailable in personal mode — requires an organization credential."),
      };
}

const inputLabel = {
  description: z.string().optional().describe("Label or hint shown with the input."),
};
const inputRequired = {
  required: z.boolean().optional().describe("Default true. false lets the recipient skip this input."),
};
const textFields = {
  defaultValue: z.string().optional().describe("Pre-filled text."),
};
const choiceOptions = {
  options: z.array(z.string().min(1)).min(2).describe("The options to pick from."),
};
const actionButtons = {
  actions: z
    .array(
      z.object({
        key: z.string().min(1).describe("Value reported back when this button is pressed."),
        label: z.string().min(1).describe("Button caption."),
        style: z.enum(["default", "primary", "destructive"]).optional().describe("Button emphasis; `destructive` for irreversible choices."),
      }),
    )
    .min(1)
    .describe("Buttons; pressing one answers the input with its key."),
};

/** Mirrors the SDK's Input union one to one; the wire format is the SDK's. */
const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), ...inputLabel, ...inputRequired, ...textFields }),
  z.object({
    type: z.literal("choice"),
    ...inputLabel,
    ...inputRequired,
    ...choiceOptions,
    multi: z.boolean().optional().describe("Allow picking several options."),
    minSelections: z.number().int().nonnegative().optional().describe("With multi: fewest picks allowed."),
    maxSelections: z.number().int().positive().optional().describe("With multi: most picks allowed."),
  }),
  z.object({ type: z.literal("actions"), ...inputLabel, ...inputRequired, ...actionButtons }),
  z.object({
    type: z.literal("slider"),
    ...inputLabel,
    ...inputRequired,
    min: z.number().optional().describe("Lowest selectable value."),
    max: z.number().optional().describe("Highest selectable value."),
    step: z.number().positive().optional().describe("Increment between selectable values."),
    unit: z.string().optional().describe("Unit shown next to the value, e.g. \"°C\" or \"%\"."),
    defaultValue: z.number().optional().describe("Initial slider position."),
  }),
  z.object({ type: z.literal("photo"), ...inputLabel, ...inputRequired }),
  z.object({ type: z.literal("voiceRecording"), ...inputLabel, ...inputRequired }),
  z.object({ type: z.literal("file"), ...inputLabel, ...inputRequired }),
  z.object({ type: z.literal("location"), ...inputLabel, ...inputRequired }),
]);

/** A notification carries at most one input, always answered. The wire shapes
 * are the SDK's NotificationTextInput / NotificationChoiceInput /
 * NotificationActionInput: a text input has no fields of its own, and none of
 * the three takes a description. */
const notificationInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).describe("A free-text field."),
  z.object({ type: z.literal("choice"), ...choiceOptions }).describe("Pick one of the options."),
  z.object({ type: z.literal("actions"), ...actionButtons }).describe("Action buttons; tapping one answers with its key."),
]);

const replyModeSchema = z.enum(["one-shot", "sticky", "one-time-per-user"]);

/** Inputs are required unless the caller says otherwise. */
function withRequired(inputs: z.infer<typeof inputSchema>[]): Input[] {
  return inputs.map((input) => ({ ...input, required: input.required ?? true }));
}

/** Sent to the client at initialize; clients put it in the model's system
 * context. Descriptions map one question to one tool — this carries the
 * routing knowledge that spans tools: where problems actually show up, and
 * that the task index has no content in it. */
const SERVER_INSTRUCTIONS = [
  "Simplepush delivers tasks and notifications to people's phones and collects what comes back — for a single person as much as for teams and field work.",
  "How to answer questions about what is happening:",
  "- Problems, complaints and reports from the field arrive three ways: as answers or replies on tasks, as declined tasks, and as ad-hoc submissions people send on their own. A question like 'any problems?', 'anything wrong with X?', 'what is going on with <member>?' or 'catch me up' is answered by get_activity (one call, all of it) — or by query_events plus query_submissions. Never by query_tasks alone: the task index shows titles, tags, topics, status, input and attachment kinds, never content.",
  "- To ask a person something: send_task creates a task and can wait for the answer; get_task_answer resolves it later. A task carries any number of inputs (text, single or multi choice, action buttons, slider, photo, voice recording, file, location) and optionally a reply thread. By default every recipient gets their own copy, tracked as a group, and waiting collects each person's answer; `shared: true` sends one task they all see, where the first answer resolves it. append_subtask adds follow-up questions or checklist items to a task or group later, using the append_token send_task returned; cancel_task withdraws a task, subtask or group sent by mistake or no longer needed. Give every task and subtask a short title: every overview — the phone's task list, query_tasks, get_activity — shows titles, tags, topics, status, input and attachment kinds, never content. send_notification is a push that expects no answer — unless it carries an `input`: a text input, a choice, or action buttons; then what the recipient entered is readable with get_notification_answer.",
  "- A question about a thing, a place or a topic — 'anything about pump 3?', 'what was said about the north site?', 'did anyone mention a leak?' — goes to search_knowledge first: it finds the tasks, answers, replies, notifications and submissions whose text contains the words, across all time, and returns the ids to read in full with get_task, get_group_status (grptsk_), get_notification_answer or query_submissions. Matching is literal unless the organization configured search languages, so prefer the exact noun. 'What happened around <place>?' is search_knowledge too, with center/radius_meters, or area_points for a polygon.",
  "- query_tasks answers 'which tasks are open / expired / declined, and who has them'. get_task shows one task's full content and answers. get_group_status shows who has and has not answered a task sent to several people.",
  "- A task can have subtasks: follow-up questions or checklist items appended to it later, each answered, replied to or declined on its own. The task index only counts them per status (the `subtasks` field, e.g. {\"pending\": 2, \"completed\": 5}); get_task returns the whole chain with every subtask's content and answers; in query_events they appear as Subtask* events carrying their subtaskId and parentTaskId. A task's own status says nothing about its subtasks — they complete independently, so a task can be pending with every subtask done, or completed with subtasks still open. To know what is still unanswered, read the subtasks counts or the chain, not the task's status.",
  "- Timestamps are ISO-8601 UTC. Content that is encrypted under a key this server does not hold comes back as ciphertext with a note saying so — say that it is unreadable, do not guess at it.",
  "- download_attachment fetches a photo, voice recording or file: scope_id is the tsk_/sub_/sbm_ id it belongs to, file_id is an answer's inputId, a reply file's id or a submission file's id. Images come back inline so you can look at them.",
].join("\n");

/** Builds the server for one connection (stdio) or one request (HTTP). The
 * factory shape is v2's own idiom, and it happens to be exactly what the hosted
 * transport needs anyway: the credential differs per request, so nothing may be
 * shared between them. */
/** The scope each tool needs. A credential's grant decides what is LISTED: a
 * tool its scopes do not cover is not registered at all, so a read-only
 * integration never carries the send tools' schemas (and the model never
 * chooses one only to be refused). The HTTP transport refuses a direct call
 * for a missing scope with a challenge as well, and the backend enforces
 * scopes regardless. */
export const TOOL_SCOPES: Record<string, string> = {
  send_notification: "send",
  send_task: "send",
  append_subtask: "send",
  cancel_task: "send",
  get_task_answer: "read",
  get_notification_answer: "read",
  query_tasks: "read",
  get_task: "read",
  get_group_status: "read",
  query_events: "read",
  query_submissions: "read",
  search_knowledge: "read",
  get_activity: "read",
  download_attachment: "files:read",
};

/** The tools of TOOL_SCOPES a grant covers; every tool when the grant is unknown. */
export function toolsFor(granted: ReadonlySet<string> | undefined): string[] {
  return Object.entries(TOOL_SCOPES)
    .filter(([, scope]) => granted === undefined || granted.has(scope))
    .map(([name]) => name);
}

/** `server.registerTool` that skips tools outside the grant. */
function gatedRegister(server: McpServer, granted: ReadonlySet<string> | undefined): McpServer["registerTool"] {
  const listed = new Set(toolsFor(granted));
  const raw = server.registerTool.bind(server) as unknown as (...args: unknown[]) => unknown;
  return ((name: string, ...rest: unknown[]) => (listed.has(name) ? raw(name, ...rest) : undefined)) as unknown as McpServer["registerTool"];
}

/** `granted` is the credential's scope set when it is known (an integration
 * token, an OAuth principal); undefined lists every tool (a personal API token
 * has no scopes). */
export function buildServer(sp: Simplepush, config: SharedConfig, granted?: ReadonlySet<string>): McpServer {
  const server = new McpServer(
    { name: "simplepush", version: "0.1.0" },
    {
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: {
        "tools/list": { ttlMs: LIST_CACHE_TTL_MS, cacheScope: "private" },
        "server/discover": { ttlMs: LIST_CACHE_TTL_MS, cacheScope: "private" },
      },
    },
  );

  const registerTool = gatedRegister(server, granted);

  registerTool(
    "send_notification",
    {
      title: "Send a push notification",
      description:
        "Send a push notification to phones. A notification lives only in the banner: once dismissed it is " +
        "gone, so it suits alerts and heads-ups, not questions that must be answered. It can still carry one " +
        "`input` — a text input, a choice, or action buttons. By default the call " +
        "returns right after sending and the answer is readable later with get_notification_answer; set " +
        "wait_seconds to wait for it in the same call. Each recipient gets their own copy by default; with " +
        "several recipients the result lists one notification_id per person. For a question that needs an " +
        "answer, a photo, file, location, slider or several inputs, use send_task.",
      inputSchema: z.object({
        content: z.string().min(1).describe("Body of the notification."),
        title: z.string().optional().describe("Optional short heading shown above the body."),
        input: notificationInputSchema.optional().describe("One input shown on the notification: free text, a choice, or action buttons."),
        image_url: z.string().url().optional().describe("Public https URL of an image shown with the notification."),
        audio_url: z.string().url().optional().describe("Public https URL of an audio clip attached to the notification."),
        link: z
          .string()
          .url()
          .optional()
          .describe("A URL shown as an \"Open link\" button on the notification. An https URL opens the browser; an app's deep link (for example unifi-protect://...) opens that app. Cannot be combined with `input`: the input's buttons take the button slots."),
        shared: z
          .boolean()
          .optional()
          .describe("Default false: a copy per recipient. true: one notification all recipients see; one person's input answer resolves it for all."),
        ...targetFields(sp),
        wait_seconds: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Default 0: return right after sending. With an input, wait this long for the answer (every recipient's, when there are several); on timeout the result marks who has not answered."),
      }),
    },
    async ({ content, title, input, image_url, audio_url, link, shared, topic, member, broadcast, wait_seconds }) => {
      try {
        const sent = await sp.sendNotification({
          content,
          ...(title !== undefined ? { title } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(image_url !== undefined ? { imageUrl: image_url } : {}),
          ...(audio_url !== undefined ? { audioUrl: audio_url } : {}),
          ...(link !== undefined ? { link } : {}),
          ...(shared !== undefined ? { shared } : {}),
          ...(topic !== undefined ? { topic } : {}),
          ...(member !== undefined ? { member } : {}),
          ...(broadcast ? { broadcast } : {}),
          waitSeconds: Math.min(wait_seconds ?? 0, config.maxWaitSeconds),
        });
        return textResult(
          "groupId" in sent
            ? {
                status: "sent",
                group_id: sent.groupId,
                notifications: sent.notifications.map((n) => ({
                  notification_id: n.notificationId,
                  ...(n.recipient !== undefined ? { recipient: n.recipient } : {}),
                  ...(n.result !== undefined ? { result: n.result } : {}),
                })),
              }
            : { status: "sent", notification_id: sent.notificationId, ...(sent.result !== undefined ? { result: sent.result } : {}) },
        );
      } catch (err) {
        return errorResult(`Could not send the notification: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "send_task",
    {
      title: "Send a task (a question, form or checklist item that needs an answer)",
      description:
        "Create a task on people's phones and wait for the answers. `content` says what to do or answer; " +
        "`inputs` says how to answer: one or more of text, choice (single or multi), action buttons, slider, " +
        "photo, voice recording, file, location, all answered in one submission. `reply` opens a comment thread on the task instead of, or in addition to, " +
        "inputs. By default every recipient gets their own copy of the task, tied together by a group; the call " +
        `waits up to wait_seconds (default ${DEFAULT_WAIT_SECONDS}s) for ALL of them to answer and returns ` +
        "per-recipient results, with whoever has not answered yet marked pending — a timeout is not a " +
        "cancellation, the tasks stay live and get_group_status or get_task_answer resolve them later. " +
        "`shared: true` sends ONE task that all recipients see and answer together (the first answer resolves " +
        "it) — use it for questions where any one person's answer settles the matter. Every result carries an " +
        "append_token for append_subtask.",
      inputSchema: z.object({
        content: z.string().optional().describe("Body of the task: what to do or answer. Required unless `inputs` is given."),
        title: z
          .string()
          .optional()
          .describe(
            "Short heading. Always set one: task listings and activity overviews show only titles, tags, topics, status, input and attachment kinds, never content, so an untitled task is unreadable there — for people scanning their phone as much as for query_tasks later.",
          ),
        tag: z.string().optional().describe("A label for grouping and filtering related tasks (e.g. a site or job number); shown on task summaries."),
        inputs: z.array(inputSchema).min(1).optional().describe("The inputs the recipient fills in, in display order."),
        reply: replyModeSchema.optional().describe(
          "Let recipients reply with comments, photos, files or voice notes: `one-shot` (one reply closes the task), `sticky` (thread stays open), `one-time-per-user` (each recipient replies once).",
        ),
        auto_commit: z
          .boolean()
          .optional()
          .describe("Default false: the task is a form — all inputs are submitted together with one Submit button. true: each input is submitted as it is filled."),
        markdown: z.boolean().optional().describe("Render `content` as Markdown."),
        links: z.array(z.string().url()).optional().describe("URLs attached to the task as links. The first one becomes an \"Open link\" button on the push when the task has no inline input. An https URL opens the browser; an app's deep link (for example unifi-protect://...) opens that app."),
        expires_at: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("ISO-8601 deadline. After it the task counts as expired and can no longer be answered."),
        shared: z
          .boolean()
          .optional()
          .describe("Default false: an independent copy per recipient, answers collected per person. true: ONE task all recipients see and answer together; the first answer resolves it."),
        ...targetFields(sp),
        wait_seconds: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            `How long to block. Default ${DEFAULT_WAIT_SECONDS}; 0 returns right after sending. With per-recipient copies (the default) it waits for everyone's answer and reports partial results at the deadline.`,
          ),
      }),
    },
    async ({ content, title, tag, inputs, reply, auto_commit, markdown, links, expires_at, shared, topic, member, broadcast, wait_seconds }) => {
      try {
        const outcome = await sp.sendTask({
          ...(content !== undefined ? { content } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(tag !== undefined ? { tag } : {}),
          ...(inputs !== undefined ? { inputs: withRequired(inputs) } : {}),
          ...(reply !== undefined ? { reply } : {}),
          ...(auto_commit !== undefined ? { autoCommit: auto_commit } : {}),
          ...(markdown ? { contentFormat: "markdown" as const } : {}),
          ...(links !== undefined ? { links } : {}),
          ...(expires_at !== undefined ? { expiresAt: expires_at } : {}),
          ...(shared !== undefined ? { shared } : {}),
          ...(topic !== undefined ? { topic } : {}),
          ...(member !== undefined ? { member } : {}),
          ...(broadcast ? { broadcast } : {}),
          waitSeconds: Math.min(wait_seconds ?? DEFAULT_WAIT_SECONDS, config.maxWaitSeconds),
        });
        return textResult(outcome);
      } catch (err) {
        return errorResult(`Could not send the task: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "append_subtask",
    {
      title: "Append a subtask to an earlier task",
      description:
        "Add a follow-up question or checklist item to a task sent with send_task. Pass the append_token from " +
        "that result: a task's token appends to that one task; a group's token appends to every instance of the " +
        "group (narrow with `instances`). Subtasks take the same content, `inputs` and `reply` as send_task and " +
        "are answered on their own; read them with get_task (the chain) or get_group_status. Never waits.",
      inputSchema: z.object({
        append_token: z.string().min(1).describe("The append_token returned by send_task (task or group)."),
        content: z.string().optional().describe("Body of the subtask. Required unless `inputs` is given."),
        title: z
          .string()
          .optional()
          .describe("Short heading. Always set one: the chain and the overviews identify subtasks by title, not content."),
        inputs: z.array(inputSchema).min(1).optional().describe("The inputs the recipient fills in, in display order."),
        reply: replyModeSchema.optional().describe("Open a comment thread on the subtask: `one-shot`, `sticky` or `one-time-per-user`."),
        auto_commit: z.boolean().optional().describe("Default false: one Submit for all inputs. true: each input is submitted as filled."),
        markdown: z.boolean().optional().describe("Render `content` as Markdown."),
        links: z.array(z.string().url()).optional().describe("URLs attached as links (https or an app's deep link scheme)."),
        instances: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe("With a group token: only these instance task ids get the subtask. Omit for every instance."),
      }),
    },
    async ({ append_token, content, title, inputs, reply, auto_commit, markdown, links, instances }) => {
      try {
        return textResult(
          await sp.appendSubtask({
            appendToken: append_token,
            ...(content !== undefined ? { content } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(inputs !== undefined ? { inputs: withRequired(inputs) } : {}),
            ...(reply !== undefined ? { reply } : {}),
            ...(auto_commit !== undefined ? { autoCommit: auto_commit } : {}),
            ...(markdown ? { contentFormat: "markdown" as const } : {}),
            ...(links !== undefined ? { links } : {}),
            ...(instances !== undefined ? { instances } : {}),
          }),
        );
      } catch (err) {
        return errorResult(`Could not append the subtask: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "cancel_task",
    {
      title: "Cancel a task, subtask or group",
      description:
        "Withdraw something sent earlier: pass a task_id (tsk_...), subtask_id (sub_...) or group_id (grptsk_...). " +
        "Pending recipients see it as canceled and can no longer answer; answers already given stay. Canceling a " +
        "group cancels every still-pending instance and reports how many were already finished. Not undoable.",
      inputSchema: z.object({
        id: z.string().min(1).describe("The tsk_ / sub_ / grptsk_ id to cancel."),
        reason: z
          .enum(["canceled", "answered", "superseded"])
          .optional()
          .describe("Why: plain withdrawal (default), the answer was obtained elsewhere, or a newer task replaces it."),
        note: z.string().optional().describe("Short explanation shown to recipients."),
        superseded_by: z.string().optional().describe("With reason `superseded`: the tsk_ id of the replacing task."),
      }),
    },
    async ({ id, reason, note, superseded_by }) => {
      try {
        return textResult(
          await sp.cancel({
            id,
            ...(reason !== undefined ? { reason } : {}),
            ...(note !== undefined ? { note } : {}),
            ...(superseded_by !== undefined ? { supersededBy: superseded_by } : {}),
          }),
        );
      } catch (err) {
        return errorResult(`Could not cancel: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "get_task_answer",
    {
      title: "Get the answer to an earlier task",
      description:
        "Check whether a task sent with send_task, or a subtask added with append_subtask, has been answered. " +
        "Pass exactly one of task_id or subtask_id. Returns the answer, or pending if the person has not replied " +
        "yet; for a subtask the result also names its parent task. A photo, voice or file answer carries its inputId " +
        "for download_attachment. For the whole task including every subtask, use get_task.",
      inputSchema: z
        .object({
          task_id: z.string().min(1).optional().describe("The tsk_ id returned by send_task."),
          subtask_id: z.string().min(1).optional().describe("The sub_ id returned by append_subtask."),
        })
        .refine((a) => (a.task_id === undefined) !== (a.subtask_id === undefined), {
          message: "Pass exactly one of task_id or subtask_id.",
        }),
    },
    async ({ task_id, subtask_id }) => {
      try {
        return textResult(await sp.getTaskAnswer(subtask_id ?? task_id ?? ""));
      } catch (err) {
        return errorResult(`Could not read the answer: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "get_notification_answer",
    {
      title: "Get the pick on an earlier notification",
      description:
        "Check whether a notification sent with send_notification and an `input` has been answered. Pass the " +
        "notification_id it returned. Returns the pick, pending if untouched, or delivered when the notification " +
        "carried no input (nothing to answer).",
      inputSchema: z.object({
        notification_id: z.string().min(1).describe("The notification_id returned by send_notification."),
      }),
    },
    async ({ notification_id }) => {
      try {
        return textResult(await sp.getNotificationAnswer(notification_id));
      } catch (err) {
        return errorResult(`Could not read the notification: ${describe(err)}`);
      }
    },
  );

  // --- the read surface: org queries ---
  // Org credentials read the organization; personal ones read the caller's
  // own sends (a subscription feature, refused with a sentence saying so).

  const statusField = z
    .array(z.enum(["pending", "completed", "declined", "expired", "canceled"]))
    .optional()
    .describe("Only tasks in these states. Omit for all.");
  const windowFields = {
    since: z.string().optional().describe("ISO-8601 instant; only items created at or after this."),
    until: z.string().optional().describe("ISO-8601 instant; only items created at or before this."),
  };
  const pageFields = {
    limit: z.number().int().positive().optional().describe("Page size. Modest default; the result carries a cursor when there is more."),
    cursor: z.string().optional().describe("Continue a previous page: pass the `cursor` it returned."),
  };

  registerTool(
    "query_tasks",
    {
      title: "List the organization's tasks",
      description:
        "Answers 'which tasks are open, expired, declined or done, and who has them'. Status only — it never shows what " +
        "people answered or reported; for that use get_task, query_events or get_activity. One page of compact summaries, " +
        "newest first: id, title, tag, topic, status, recipients, input kinds and reply mode (what sort of answer it expects), " +
        "attachment kinds (file, link), sent " +
        "time, and a per-status count of the task's subtasks (checklist items). Filter by status, time window, topic, member, or group.",
      inputSchema: z.object({
        status: statusField,
        ...windowFields,
        topic: z.string().optional().describe("Only tasks sent to this topic: its name, or its id."),
        member: z.string().optional().describe("Only tasks delivered to this member (name or usr_ id)."),
        group: z.string().optional().describe("Only the instances of this task group (grptsk_ id)."),
        ...pageFields,
      }),
    },
    async (args) => {
      try {
        return textResult(await queryTasks(sp, args));
      } catch (err) {
        return errorResult(`Could not list tasks: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "get_task",
    {
      title: "Read one task with its subtasks",
      description:
        "Answers 'what exactly was asked and answered on this task'. The full content of one task and every subtask " +
        "appended to it: who it was delivered to (recipients), the questions, the answers given, replies, declines, and the " +
        "uploads (inputId) and reply files (id) for download_attachment. Use after query_tasks or get_activity has identified the task. " +
        "A task sent to several people carries its grptsk_ groupId — follow it with get_group_status for the other " +
        "recipients' copies.",
      inputSchema: z.object({
        task_id: z.string().min(1).describe("The tsk_ id."),
      }),
    },
    async ({ task_id }) => {
      try {
        return textResult(await getTask(sp, task_id));
      } catch (err) {
        return errorResult(`Could not read the task: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "get_group_status",
    {
      title: "Status of a task group",
      description:
        "Answers 'who has answered and who has not' for a task sent to several people as independent copies " +
        "(a grptsk_ group id, as shown on tasks from query_tasks): one summary per recipient plus a count per status.",
      inputSchema: z.object({
        group_id: z.string().min(1).describe("The grptsk_ id."),
        status: statusField,
      }),
    },
    async ({ group_id, status }) => {
      try {
        return textResult(await getGroupStatus(sp, group_id, status));
      } catch (err) {
        return errorResult(`Could not read the group: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "query_events",
    {
      title: "Read the organization's activity history",
      description:
        "Answers 'what happened' — the place to look for anything reported, answered, replied, declined or cancelled, " +
        "oldest first, each with who did it and when. This is where problems surface; query_tasks does not contain them. " +
        "Defaults to the last 7 days. Filter by member or by event type (TaskCompleted, TaskInputCompleted, " +
        "SubtaskCompleted, ReplyAppended, SubmissionCreated, TaskDeclinedByRecipient, TaskCanceled, TaskExpired, ...). " +
        "For a ready-made bundle per member use get_activity; for ad-hoc reports alone use query_submissions.",
      inputSchema: z.object({
        type: z.array(z.string().min(1)).optional().describe("Only these event types (wire names, e.g. TaskCompleted)."),
        ...windowFields,
        member: z.string().optional().describe("Only actions by this member (name or usr_ id)."),
        ...pageFields,
      }),
    },
    async (args) => {
      try {
        return textResult(await queryEvents(sp, args));
      } catch (err) {
        return errorResult(`Could not read events: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "query_submissions",
    {
      title: "Read ad-hoc submissions from the field",
      description:
        "Answers 'did anyone report something on their own' — reports people sent without being asked (not answers to " +
        "a task): text, photo, file, voice note, location, with who sent it and when. Check this whenever a question " +
        "is about problems or reports; the task index never shows these. Oldest first; defaults to the last 7 days. " +
        "Photos and files carry their id for download_attachment (scope_id = the sbm_ id).",
      inputSchema: z.object({
        ...windowFields,
        member: z.string().optional().describe("Only submissions by this member (name or usr_ id)."),
        ...pageFields,
      }),
    },
    async (args) => {
      try {
        return textResult(await querySubmissions(sp, args));
      } catch (err) {
        return errorResult(`Could not read submissions: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "search_knowledge",
    {
      title: "Search everything by words or by place",
      description:
        "Full-text and location search over everything this credential reads — the organization's records, or what a personal " +
        "account sent and submitted: task titles and content, answers, replies, notifications " +
        "and their answers, and ad-hoc submissions — across all time, ranked. Use it for 'anything about X?', 'what " +
        "was said about X?', 'who mentioned X?'. Words match literally, and by stem in the languages the organization " +
        "configured (so 'leak' finds 'leaking' only where stemming is on); several words must all appear; quote a " +
        "phrase for adjacency. For 'what happened around <place>?' pass center/radius_meters instead of " +
        "(or on top of) the query: alone they return the location answers, replies and submissions recorded within the " +
        "radius, nearest first; with a query, text hits are kept only when their task or submission carries an " +
        "in-radius point. For a shape rather than a circle — a site, a block, a stretch of road — pass area_points, " +
        "a polygon of 3 to 50 corners, instead; those hits carry no distance and come newest first. " +
        "Resolve a street or site name to coordinates yourself first, and prefer a generous radius " +
        "when the coordinates are geocoded rather than known. Each hit carries the " +
        "id to read in full (tsk_/sub_ with get_task, grptsk_ — a task sent to several people — with get_group_status, " +
        "ntf_ with get_notification_answer, sbm_ with query_submissions) " +
        "and a snippet with the matching words in brackets (a location hit carries its point and distance instead). " +
        "Encrypted records are not searchable.",
      inputSchema: z.object({
        query: z.string().min(1).optional().describe("The words to look for. Optional when center or area_points is given."),
        center: z
          .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
          .optional()
          .describe("WGS84 center of a radius filter; requires radius_meters."),
        radius_meters: z.number().int().min(1).max(1000000).optional().describe("Radius around center, in meters."),
        area_points: z
          .array(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }))
          .min(3)
          .max(50)
          .optional()
          .describe("Corners of a polygon to search inside instead of a circle; not combinable with center/radius_meters."),
        kind: z
          .array(z.enum(["task", "subtask", "answer", "reply", "notification", "notification_answer", "submission"]))
          .optional()
          .describe("Only these kinds of hit."),
        ...windowFields,
        member: z.string().optional().describe("Only units written by this person: a usr_ id, an org member's name, or on a personal account the name of someone in your own activity."),
        limit: z.number().int().positive().optional().describe("Best hits to return; default 20, at most 100."),
      }),
    },
    async (args) => {
      try {
        return textResult(await searchKnowledge(sp, args));
      } catch (err) {
        return errorResult(`Could not search: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "get_activity",
    {
      title: "Everything going on for a member (or the whole organization)",
      description:
        "Use this first for 'any problems with <member>?', 'what is going on with <member> / at the site?', " +
        "'catch me up', 'anything I should know?'. One call returns the bundle: open tasks, tasks that " +
        "were declined or expired, and the window's answers, replies, declines, cancellations and ad-hoc submissions " +
        "— with who and when. Defaults to the last 7 days. Omit member for the whole organization.",
      inputSchema: z.object({
        member: z.string().optional().describe("Member name or usr_ id. Omit for the whole organization."),
        since: z.string().optional().describe("ISO-8601 instant; default is 7 days ago."),
      }),
    },
    async (args) => {
      try {
        return textResult(await getActivity(sp, args));
      } catch (err) {
        return errorResult(`Could not gather activity: ${describe(err)}`);
      }
    },
  );

  registerTool(
    "download_attachment",
    {
      title: "Download a photo or file",
      description:
        "Fetches a photo, voice recording or file by the id of what holds it and the id of the file, the same pair the " +
        "SDK's download takes. Images come back inline so you can look at them; other files come back as a short-lived " +
        "download URL plus metadata. Needs the 'files:read' scope.",
      inputSchema: z.object({
        scope_id: z.string().min(1).describe("The tsk_ or sub_ id for an answer's or a reply's file, the sbm_ id for a submission's file."),
        file_id: z
          .string()
          .min(1)
          .describe("An answer's inputId (inp_) from send_task, get_task_answer or get_task; a reply's photo/file/audio id (rfl_) from get_task or query_events; a submission's photo/file/audio id (sbf_) from query_submissions."),
      }),
    },
    async ({ scope_id, file_id }) => {
      try {
        const result = await downloadAttachment(sp, { scopeId: scope_id, fileId: file_id });
        if (result.kind === "image") {
          return {
            content: [
              { type: "image" as const, data: result.data, mimeType: result.mimeType },
              { type: "text" as const, text: JSON.stringify({ mimeType: result.mimeType, bytes: result.bytes }) },
            ],
          };
        }
        return textResult(result);
      } catch (err) {
        return errorResult(`Could not download the file: ${describe(err)}`);
      }
    },
  );

  return server;
}

/** The read side of the server: the query endpoints (the org twins in org
 * mode, the personal ones — the caller's own sends and stream — in personal
 * mode), shaped for a model.
 *
 * Every function here does the same three things: call one backend read
 * endpoint, decrypt what it can (the SDK field-schema decryptors), and return a
 * terse structure — summaries rather than stored payloads, wire noise
 * stripped, absent rather than null. Pagination is passed through as an
 * opaque `cursor` the model hands back to continue.
 */
import type { Simplepush } from "./simplepush.js";
import { decryptEvent, decryptSubmission, decryptTaskPayload, decryptTaskSummary, type EncryptionMarker, type Event, type SearchKind, type TaskStatus, type TaskSummary } from "@simplepush/sdk";

type ActorWire = { publicId: string; name?: string; deviceName?: string };
type SubmissionWire = {
  id: string;
  body?: { type: string; value?: string };
  photo?: FileWire;
  file?: FileWire;
  audio?: FileWire & { durationSeconds?: number };
  location?: unknown;
  createdAt: string;
};
type FileWire = { id: string; contentType?: string; size?: number; filename?: string };

// --- shaping ---

/** Per-page defaults below the backend's: a tool result competes for the
 * model's context, and the cursor is always there for more. */
const TASKS_PAGE = 25;
const EVENTS_PAGE = 50;
const SUBMISSIONS_PAGE = 25;
const MAX_PAGE = 100;
const DEFAULT_WINDOW_DAYS = 7;

/** Fields a model never needs: storage/versioning details and the file
 * checksums. Everything else in a decrypted payload passes through. */
const NOISE = new Set(["version", "autoCommit", "contentFormat", "topicId", "checksumSha256", "objectKey"]);

function trim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trim);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (NOISE.has(k) || v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = trim(v);
    }
    return out;
  }
  return value;
}

function who(actor: ActorWire | undefined): string | undefined {
  if (!actor) return undefined;
  return actor.name ?? actor.publicId;
}

function recipientNames(recipients: TaskSummary["recipients"]): string[] {
  return recipients.map((r) => r.name ?? r.publicId);
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(limit ?? fallback, 1), MAX_PAGE);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A note the model can relay when ciphertext stayed ciphertext. */
function undecryptableNote(count: number): { note?: string } {
  return count > 0 ? { note: `${count} value(s) are encrypted under a key this server does not hold and were left as ciphertext.` } : {};
}

async function shapeSummary(sp: Simplepush, t: TaskSummary): Promise<{ summary: Record<string, unknown>; undecryptable: number }> {
  const dec = await decryptTaskSummary(t, await sp.keyring());
  const row = dec.value as TaskSummary;
  const summary: Record<string, unknown> = {
    taskId: t.taskId,
    ...(row.title !== undefined ? { title: row.title } : {}),
    ...(row.tag !== undefined ? { tag: row.tag } : {}),
    status: t.status,
    ...(t.topic !== undefined ? { topic: t.topic } : {}),
    createdAt: t.createdAt,
    ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
    recipients: recipientNames(t.recipients),
    ...(t.inputs.length > 0 ? { inputs: t.inputs } : {}),
    ...(t.attachments.length > 0 ? { attachments: t.attachments } : {}),
    ...(t.reply !== undefined ? { reply: t.reply } : {}),
    ...(Object.keys(t.subtasks).length > 0 ? { subtasks: t.subtasks } : {}),
    ...(t.groupId !== undefined ? { groupId: t.groupId } : {}),
    ...(t.orgTopicId !== undefined ? { topicId: t.orgTopicId } : {}),
  };
  return { summary, undecryptable: dec.undecryptable };
}

async function shapeSummaries(sp: Simplepush, tasks: TaskSummary[]): Promise<{ tasks: Record<string, unknown>[]; undecryptable: number }> {
  let undecryptable = 0;
  const shaped: Record<string, unknown>[] = [];
  for (const t of tasks) {
    const r = await shapeSummary(sp, t);
    shaped.push(r.summary);
    undecryptable += r.undecryptable;
  }
  return { tasks: shaped, undecryptable };
}

// --- tools ---

export type QueryTasksArgs = {
  status?: string[];
  since?: string;
  until?: string;
  topic?: string;
  member?: string;
  group?: string;
  limit?: number;
  cursor?: string;
};

export async function queryTasks(sp: Simplepush, args: QueryTasksArgs): Promise<Record<string, unknown>> {
  const page = await sp.client.listTasks({
      status: args.status as TaskStatus[] | undefined,
      since: args.since,
      until: args.until,
      topic: args.topic,
      member: args.member,
      group: args.group,
      limit: clampLimit(args.limit, TASKS_PAGE),
      cursor: args.cursor,
    });
  const { tasks, undecryptable } = await shapeSummaries(sp, page.tasks);
  return { tasks, ...(page.nextCursor !== undefined ? { cursor: page.nextCursor } : {}), ...undecryptableNote(undecryptable) };
}

export async function getTask(sp: Simplepush, taskId: string): Promise<Record<string, unknown>> {
  const chain = await sp.client.getTaskChain(taskId);
  const root = await decryptTaskPayload(chain.task, await sp.keyring());
  let undecryptable = root.undecryptable;
  const subtasks: unknown[] = [];
  for (const s of chain.subtasks) {
    const d = await decryptTaskPayload(s.subtask, await sp.keyring());
    undecryptable += d.undecryptable;
    subtasks.push({ ...(trim(d.value) as Record<string, unknown>), createdAt: s.createdAt });
  }
  return {
    task: { ...(trim(root.value) as Record<string, unknown>), createdAt: chain.createdAt },
    ...(subtasks.length > 0 ? { subtasks } : {}),
    ...(chain.groupId !== undefined ? { groupId: chain.groupId, groupNote: "sent to several people as a group; see get_group_status for the other recipients" } : {}),
    ...undecryptableNote(undecryptable),
  };
}

export async function getGroupStatus(sp: Simplepush, groupId: string, status?: string[]): Promise<Record<string, unknown>> {
  const group = await sp.client.getTaskGroup(groupId, { status: status as TaskStatus[] | undefined });
  const { tasks, undecryptable } = await shapeSummaries(sp, group.tasks);
  const counts: Record<string, number> = {};
  for (const t of group.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { groupId: group.groupId, counts, tasks, ...undecryptableNote(undecryptable) };
}

export type QueryEventsArgs = {
  type?: string[];
  since?: string;
  until?: string;
  member?: string;
  limit?: number;
  cursor?: string;
};

export async function queryEvents(sp: Simplepush, args: QueryEventsArgs): Promise<Record<string, unknown>> {
  // No window and no cursor means "recent", not "everything since the org
  // was created" — the default window keeps a bare call bounded.
  const since = args.since ?? (args.cursor === undefined ? daysAgo(DEFAULT_WINDOW_DAYS) : undefined);
  const page = await sp.client.listEvents({
      type: args.type,
      since,
      until: args.until,
      member: args.member,
      limit: clampLimit(args.limit, EVENTS_PAGE),
      cursor: args.cursor,
    });
  let undecryptable = 0;
  const events: unknown[] = [];
  for (const e of page.events) {
    const d = await decryptEvent(e, await sp.keyring());
    undecryptable += d.undecryptable;
    const by = who(e.actor);
    events.push({
      version: e.version,
      type: e.eventType,
      createdAt: e.createdAt,
      ...(by !== undefined ? { by } : {}),
      data: trim((d.value as Event).data),
    });
  }
  return {
    ...(args.since === undefined && since !== undefined ? { since } : {}),
    events,
    ...(page.nextCursor !== undefined ? { cursor: page.nextCursor } : {}),
    ...undecryptableNote(undecryptable),
  };
}

export type QuerySubmissionsArgs = {
  since?: string;
  until?: string;
  member?: string;
  limit?: number;
  cursor?: string;
};

export async function querySubmissions(sp: Simplepush, args: QuerySubmissionsArgs): Promise<Record<string, unknown>> {
  const since = args.since ?? (args.cursor === undefined ? daysAgo(DEFAULT_WINDOW_DAYS) : undefined);
  const page = await sp.client.listSubmissions({
      since,
      until: args.until,
      member: args.member,
      limit: clampLimit(args.limit, SUBMISSIONS_PAGE),
      cursor: args.cursor,
    });
  let undecryptable = 0;
  const submissions: unknown[] = [];
  for (const entry of page.submissions) {
    const d = await decryptSubmission(entry.submission, await sp.keyring(), entry.encryption);
    undecryptable += d.undecryptable;
    const s = d.value as SubmissionWire;
    const by = who(entry.actor);
    submissions.push({
      submissionId: s.id,
      createdAt: s.createdAt,
      ...(by !== undefined ? { by } : {}),
      ...(s.body?.value !== undefined ? { text: s.body.value } : {}),
      ...(s.photo ? { photo: fileRef(s.photo) } : {}),
      ...(s.file ? { file: fileRef(s.file) } : {}),
      ...(s.audio ? { audio: { ...fileRef(s.audio), ...(s.audio.durationSeconds !== undefined ? { durationSeconds: s.audio.durationSeconds } : {}) } } : {}),
      ...(s.location !== undefined ? { location: trim(s.location) } : {}),
    });
  }
  return {
    ...(args.since === undefined && since !== undefined ? { since } : {}),
    submissions,
    ...(page.nextCursor !== undefined ? { cursor: page.nextCursor } : {}),
    ...undecryptableNote(undecryptable),
  };
}

export type SearchArgs = {
  query?: string;
  center?: { latitude: number; longitude: number };
  radius_meters?: number;
  area_points?: { latitude: number; longitude: number }[];
  kind?: string[];
  since?: string;
  until?: string;
  member?: string;
  limit?: number;
};

const SEARCH_PAGE = 20;

/** Ranked hits with the id to follow up on: tsk_/sub_ -> get_task, ntf_ ->
 * get_notification_answer, sbm_ -> query_submissions. */
export async function searchKnowledge(sp: Simplepush, args: SearchArgs): Promise<Record<string, unknown>> {
  const res = await sp.client.search(args.query, {
    ...(args.center !== undefined ? { near: args.center, radiusMeters: args.radius_meters } : {}),
    ...(args.area_points !== undefined ? { within: args.area_points } : {}),
    kind: args.kind as SearchKind[] | undefined,
    since: args.since,
    until: args.until,
    member: args.member,
    limit: clampLimit(args.limit, SEARCH_PAGE),
  });
  return {
    hits: res.hits.map((h) => ({
      kind: h.kind,
      id: h.ref,
      ...(h.title !== undefined ? { title: h.title } : {}),
      ...(h.actor !== undefined ? { by: h.actor } : {}),
      createdAt: h.createdAt,
      ...(h.snippet !== undefined ? { snippet: h.snippet } : {}),
      ...(h.location !== undefined
        ? {
            location: { latitude: h.location.latitude, longitude: h.location.longitude },
            ...(h.location.distanceMeters !== undefined ? { distanceMeters: Math.round(h.location.distanceMeters) } : {}),
          }
        : {}),
    })),
  };
}

function fileRef(f: FileWire): Record<string, unknown> {
  return {
    id: f.id,
    ...(f.contentType !== undefined ? { contentType: f.contentType } : {}),
    ...(f.size !== undefined ? { size: f.size } : {}),
    ...(f.filename !== undefined ? { filename: f.filename } : {}),
  };
}

// --- downloads ---

/** Images this large and below come back inline as an MCP image block; above
 * that (or for any non-image) the model gets metadata plus a presigned URL. */
const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** The SDK routes on the prefixes: tsk_/sub_/sbm_ for the scope, inp_/rfl_/sbf_ for the file. */
export type DownloadArgs = { scopeId: string; fileId: string };

export type DownloadResult =
  | { kind: "image"; mimeType: string; data: string; bytes: number }
  | { kind: "url"; url: string; bytes?: number; mimeType?: string; note: string };

export async function downloadAttachment(sp: Simplepush, { scopeId, fileId }: DownloadArgs): Promise<DownloadResult> {
  const meta = await sp.client.fileDownloadUrl(scopeId, fileId);
  const mimeType = meta.contentType;

  if (mimeType.startsWith("image/") && meta.size <= INLINE_IMAGE_MAX_BYTES) {
    const file = await sp.client.downloadFile(scopeId, fileId);
    return { kind: "image", mimeType, data: Buffer.from(file.bytes).toString("base64"), bytes: file.bytes.byteLength };
  }
  const note = mimeType.startsWith("audio/")
    ? "Audio cannot be read by this tool; the URL serves the file for ~5 minutes."
    : mimeType.startsWith("image/")
      ? "Image too large to return inline; the URL serves it for ~5 minutes."
      : "Not an image; the URL serves the file for ~5 minutes.";
  return {
    kind: "url",
    url: meta.url,
    mimeType,
    bytes: meta.size,
    note: meta.encryption !== undefined ? `${note} The stored bytes are encrypted; only a key holder can read them.` : note,
  };
}

// --- composite: the question-shaped tool ---

/** Which section of an activity bundle an event belongs to. Submissions are
 * fetched through their own endpoint, so SubmissionCreated is skipped here. */
const EVENT_SECTIONS: Record<string, string> = {
  TaskCompleted: "answers",
  TaskInputCompleted: "answers",
  SubtaskCompleted: "answers",
  SubtaskInputCompleted: "answers",
  ReplyAppended: "replies",
  TaskDeclinedByRecipient: "declines",
  SubtaskDeclinedByRecipient: "declines",
  TaskDeclined: "declines",
  SubtaskDeclined: "declines",
  TaskCanceled: "cancellations",
  SubtaskCanceled: "cancellations",
  TaskExpired: "expiries",
};

export type ActivityArgs = { member?: string; since?: string };

/** Everything relevant to "what is going on / any problems" for one member
 * (or the whole org) in one call: open tasks, tasks that were
 * declined or expired, and the window's answers, replies, declines,
 * cancellations and ad-hoc submissions. Composes the single-purpose queries
 * so the model does not have to plan the fan-out itself. */
export async function getActivity(sp: Simplepush, args: ActivityArgs): Promise<Record<string, unknown>> {
  const since = args.since ?? daysAgo(DEFAULT_WINDOW_DAYS);
  const [open, closed, events, submissions] = await Promise.all([
    queryTasks(sp, { status: ["pending"], member: args.member, limit: TASKS_PAGE }),
    queryTasks(sp, { status: ["declined", "expired"], member: args.member, since, limit: TASKS_PAGE }),
    queryEvents(sp, { member: args.member, since, limit: MAX_PAGE }),
    querySubmissions(sp, { member: args.member, since, limit: TASKS_PAGE }),
  ]);

  const openTasks = open.tasks as Record<string, unknown>[];
  const closedTasks = closed.tasks as Record<string, unknown>[];

  const sections: Record<string, unknown[]> = {};
  for (const e of events.events as Record<string, unknown>[]) {
    const type = e.type as string;
    if (type === "SubmissionCreated") continue;
    const section = EVENT_SECTIONS[type] ?? "other";
    (sections[section] ??= []).push(e);
  }

  const more: Record<string, string> = {};
  if (typeof open.cursor === "string") more.openTasks = open.cursor;
  if (typeof events.cursor === "string") more.events = events.cursor;
  if (typeof submissions.cursor === "string") more.submissions = submissions.cursor;

  const notes = [open.note, closed.note, events.note, submissions.note].filter((n): n is string => typeof n === "string");

  return {
    ...(args.member !== undefined ? { member: args.member } : {}),
    since,
    openTasks,
    declinedTasks: closedTasks.filter((t) => t.status === "declined"),
    expiredTasks: closedTasks.filter((t) => t.status === "expired"),
    ...sections,
    submissions: submissions.submissions,
    ...(Object.keys(more).length > 0
      ? { more, moreNote: "A cursor here means that section was cut off; continue it with the matching single-purpose tool." }
      : {}),
    ...(notes.length > 0 ? { note: notes[0] } : {}),
  };
}

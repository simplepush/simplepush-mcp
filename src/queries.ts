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
import { decryptEvent, decryptSubmission, decryptTaskPayload, decryptTaskSummary, type EncryptionMarker, type SearchKind, type TaskStatus, type TaskSummary } from "@simplepush/sdk";

type SubmissionWire = {
  id: string;
  body?: { type: string; value?: string };
  photo?: FileWire;
  file?: FileWire;
  audio?: FileWire & { durationSeconds?: number };
  location?: LocationWire;
  createdAt: string;
};
type FileWire = { id: string; contentType?: string; size?: number; filename?: string };

// --- result shapes ---

/** A person as every tool names one: the stable `usr_` handle to filter or
 * cross-reference by, plus the display name when there is one. */
type Person = { publicId: string; name?: string };

type FileRef = { id: string; contentType?: string; size?: number; filename?: string };

/** A location answer after decryption: the coordinates, or only the
 * `encrypted` blob when no held key opens it. */
type LocationWire =
  | { latitude: number; longitude: number; accuracy?: number; altitude?: number; heading?: number; speed?: number; timestamp?: number }
  | { encrypted: string };

/** The tail every page result carries: the window start when the tool chose
 * it, the cursor to continue with, and the ciphertext note. */
type PageTail = { since?: string; cursor?: string; note?: string };

/** One task as the index shows it: what was asked of whom and its state,
 * never the content. */
type TaskView = {
  taskId: string;
  title?: string;
  tag?: string;
  status: TaskStatus;
  topic?: string;
  createdAt: string;
  expiresAt?: string;
  recipients: Person[];
  inputs?: string[];
  attachments?: string[];
  reply?: TaskSummary["reply"];
  subtasks?: Record<string, number>;
  groupId?: string;
  topicId?: string;
};
export type TasksResult = { tasks: TaskView[] } & PageTail;

/** A stored task or subtask payload after decryption and `trim`, passed
 * through as JSON: the field shapes are the backend's, not restated here. */
type Payload = Record<string, unknown>;
export type TaskChainView = {
  task: Payload & { createdAt: string };
  recipients: Person[];
  subtasks?: (Payload & { createdAt: string })[];
  groupId?: string;
  groupNote?: string;
  note?: string;
};

export type GroupStatusView = { groupId: string; counts: Record<string, number>; tasks: TaskView[]; note?: string };

/** One event: its envelope reduced to type, time and actor, plus the
 * decrypted payload (whichever event type it is). */
type EventView = { version?: number; type: string; createdAt?: string; by?: Person; data: unknown };
export type EventsResult = { events: EventView[] } & PageTail;

type SubmissionView = {
  submissionId: string;
  createdAt: string;
  by?: Person;
  text?: string;
  photo?: FileRef;
  file?: FileRef;
  audio?: FileRef & { durationSeconds?: number };
  location?: LocationWire;
};
export type SubmissionsResult = { submissions: SubmissionView[] } & PageTail;

type SearchHitView = {
  kind: SearchKind;
  id: string;
  title?: string;
  by?: string;
  createdAt: string;
  snippet?: string;
  location?: { latitude: number; longitude: number };
  distanceMeters?: number;
};
export type SearchResult = { hits: SearchHitView[] };

type Section = "answers" | "replies" | "declines" | "cancellations" | "expiries" | "other";
export type ActivityView = {
  member?: string;
  since: string;
  openTasks: TaskView[];
  declinedTasks: TaskView[];
  expiredTasks: TaskView[];
  submissions: SubmissionView[];
  more?: Record<string, string>;
  moreNote?: string;
  note?: string;
} & Partial<Record<Section, EventView[]>>;

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

function person(p: { publicId: string; name?: string }): Person {
  return { publicId: p.publicId, ...(p.name !== undefined ? { name: p.name } : {}) };
}

function recipientRefs(recipients: TaskSummary["recipients"]): Person[] {
  return recipients.map(person);
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

async function shapeSummary(sp: Simplepush, t: TaskSummary): Promise<{ summary: TaskView; undecryptable: number }> {
  const dec = await decryptTaskSummary(t, await sp.keyring());
  const row = dec.value;
  const summary: TaskView = {
    taskId: t.taskId,
    ...(row.title !== undefined ? { title: row.title } : {}),
    ...(row.tag !== undefined ? { tag: row.tag } : {}),
    status: t.status,
    ...(t.topic !== undefined ? { topic: t.topic } : {}),
    createdAt: t.createdAt,
    ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
    recipients: recipientRefs(t.recipients),
    ...(t.inputs.length > 0 ? { inputs: t.inputs } : {}),
    ...(t.attachments.length > 0 ? { attachments: t.attachments } : {}),
    ...(t.reply !== undefined ? { reply: t.reply } : {}),
    ...(Object.keys(t.subtasks).length > 0 ? { subtasks: t.subtasks } : {}),
    ...(t.groupId !== undefined ? { groupId: t.groupId } : {}),
    ...(t.orgTopicId !== undefined ? { topicId: t.orgTopicId } : {}),
  };
  return { summary, undecryptable: dec.undecryptable };
}

async function shapeSummaries(sp: Simplepush, tasks: TaskSummary[]): Promise<{ tasks: TaskView[]; undecryptable: number }> {
  let undecryptable = 0;
  const shaped: TaskView[] = [];
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

export async function queryTasks(sp: Simplepush, args: QueryTasksArgs): Promise<TasksResult> {
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

export async function getTask(sp: Simplepush, taskId: string): Promise<TaskChainView> {
  const chain = await sp.client.getTaskChain(taskId);
  const root = await decryptTaskPayload(chain.task, await sp.keyring());
  let undecryptable = root.undecryptable;
  const subtasks: TaskChainView["subtasks"] = [];
  for (const s of chain.subtasks) {
    const d = await decryptTaskPayload(s.subtask, await sp.keyring());
    undecryptable += d.undecryptable;
    subtasks.push({ ...(trim(d.value) as Payload), createdAt: s.createdAt });
  }
  return {
    task: { ...(trim(root.value) as Payload), createdAt: chain.createdAt },
    recipients: recipientRefs(chain.recipients),
    ...(subtasks.length > 0 ? { subtasks } : {}),
    ...(chain.groupId !== undefined ? { groupId: chain.groupId, groupNote: "sent to several people as a group; see get_group_status for the other recipients" } : {}),
    ...undecryptableNote(undecryptable),
  };
}

export async function getGroupStatus(sp: Simplepush, groupId: string, status?: string[]): Promise<GroupStatusView> {
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

export async function queryEvents(sp: Simplepush, args: QueryEventsArgs): Promise<EventsResult> {
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
  const events: EventView[] = [];
  for (const e of page.events) {
    const d = await decryptEvent(e, await sp.keyring());
    undecryptable += d.undecryptable;
    events.push({
      version: e.version,
      type: e.eventType,
      createdAt: e.createdAt,
      ...(e.actor !== undefined ? { by: person(e.actor) } : {}),
      data: trim(d.value.data),
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

export async function querySubmissions(sp: Simplepush, args: QuerySubmissionsArgs): Promise<SubmissionsResult> {
  const since = args.since ?? (args.cursor === undefined ? daysAgo(DEFAULT_WINDOW_DAYS) : undefined);
  const page = await sp.client.listSubmissions({
      since,
      until: args.until,
      member: args.member,
      limit: clampLimit(args.limit, SUBMISSIONS_PAGE),
      cursor: args.cursor,
    });
  let undecryptable = 0;
  const submissions: SubmissionView[] = [];
  for (const entry of page.submissions) {
    const d = await decryptSubmission(entry.submission as SubmissionWire, await sp.keyring(), entry.encryption);
    undecryptable += d.undecryptable;
    const s = d.value;
    submissions.push({
      submissionId: s.id,
      createdAt: s.createdAt,
      ...(entry.actor !== undefined ? { by: person(entry.actor) } : {}),
      ...(s.body?.value !== undefined ? { text: s.body.value } : {}),
      ...(s.photo ? { photo: fileRef(s.photo) } : {}),
      ...(s.file ? { file: fileRef(s.file) } : {}),
      ...(s.audio ? { audio: { ...fileRef(s.audio), ...(s.audio.durationSeconds !== undefined ? { durationSeconds: s.audio.durationSeconds } : {}) } } : {}),
      ...(s.location !== undefined ? { location: trim(s.location) as LocationWire } : {}),
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
export async function searchKnowledge(sp: Simplepush, args: SearchArgs): Promise<SearchResult> {
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

function fileRef(f: FileWire): FileRef {
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
const EVENT_SECTIONS: Record<string, Section> = {
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
export async function getActivity(sp: Simplepush, args: ActivityArgs): Promise<ActivityView> {
  const since = args.since ?? daysAgo(DEFAULT_WINDOW_DAYS);
  const [open, closed, events, submissions] = await Promise.all([
    queryTasks(sp, { status: ["pending"], member: args.member, limit: TASKS_PAGE }),
    queryTasks(sp, { status: ["declined", "expired"], member: args.member, since, limit: TASKS_PAGE }),
    queryEvents(sp, { member: args.member, since, limit: MAX_PAGE }),
    querySubmissions(sp, { member: args.member, since, limit: TASKS_PAGE }),
  ]);

  const sections: Partial<Record<Section, EventView[]>> = {};
  for (const e of events.events) {
    if (e.type === "SubmissionCreated") continue;
    const section = EVENT_SECTIONS[e.type] ?? "other";
    (sections[section] ??= []).push(e);
  }

  const more: Record<string, string> = {};
  if (open.cursor !== undefined) more.openTasks = open.cursor;
  if (events.cursor !== undefined) more.events = events.cursor;
  if (submissions.cursor !== undefined) more.submissions = submissions.cursor;

  const notes = [open.note, closed.note, events.note, submissions.note].filter((n): n is string => n !== undefined);

  return {
    ...(args.member !== undefined ? { member: args.member } : {}),
    since,
    openTasks: open.tasks,
    declinedTasks: closed.tasks.filter((t) => t.status === "declined"),
    expiredTasks: closed.tasks.filter((t) => t.status === "expired"),
    ...sections,
    submissions: submissions.submissions,
    ...(Object.keys(more).length > 0
      ? { more, moreNote: "A cursor here means that section was cut off; continue it with the matching single-purpose tool." }
      : {}),
    ...(notes.length > 0 ? { note: notes[0] } : {}),
  };
}

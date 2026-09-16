import { Client, Keyring, OrgClient, decryptNotificationPayload, decryptTaskPayload } from "@simplepush/sdk";
import { importKey } from "@simplepush/sdk";
import type { CancelReason, DerivedKey, EncryptionMarker, Input, KeysConfig, NotificationInput, PersonalKeyInput, ReplyMode, SendOptions, SendSubtaskOptions } from "@simplepush/sdk";
import { isSubtaskGroupResponse } from "@simplepush/sdk";

/** Who this server acts as.
 *
 * `personal` — one user; API-Token from the environment (stdio) or an OAuth
 * access token from the request (hosted HTTP). Optional exported keys for
 * encrypted sends.
 *
 * `org` — an organization, as a client already built from an integration
 * token (`OrgClient.fromIntegrationToken`), holding the org master keys when
 * the org has encryption enabled.
 */
export type Mode =
  | { kind: "personal"; credential: { apiToken: string } | { accessToken: string }; keys?: KeysConfig }
  | { kind: "org"; client: OrgClient };

export type SimplepushOptions = {
  mode: Mode;
  baseUrl: string;
  /** Ceiling on how long `ask` may block. */
  maxWaitSeconds: number;
  /** Gap between answer polls while blocking. */
  pollIntervalMs?: number;
};

/** One human's answer to one input, flattened to something a model can read.
 * `value` is plaintext where this server holds the key, else the ciphertext;
 * the outcome's `undecryptable` count says how many stayed sealed. */
export type Answer = {
  kind: string;
  value?: string;
  /** File answers: the inp_ id download_attachment takes as `file_id` with kind `input`. */
  inputId?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  durationSeconds?: number;
};

export type NotificationOutcome =
  | { status: "answered"; notificationId: string; answer: Answer; undecryptable?: number }
  | { status: "pending"; notificationId: string }
  /** No input on the notification — nothing to answer. */
  | { status: "delivered"; notificationId: string };

/** For a subtask, `taskId` is the parent's and `subtaskId` names the subtask. */
export type AskOutcome =
  | { status: "answered"; taskId: string; subtaskId?: string; answers: Answer[]; undecryptable?: number; appendToken?: string }
  | { status: "pending"; taskId: string; subtaskId?: string; appendToken?: string }
  | { status: "closed"; taskId: string; subtaskId?: string; reason: string; appendToken?: string };

/** One instance's answer state inside a group outcome. */
export type InstanceResult =
  | { status: "answered"; answers: Answer[] }
  | { status: "pending" }
  | { status: "closed"; reason: string };

/** A send in independent mode (the default): one task per recipient, tied by
 * a group. The group-level appendToken fans a subtask across every instance;
 * each instance's own token targets just that recipient. `status` is "sent"
 * when the call did not wait; after waiting it is "answered" (everyone),
 * "partial" (some) or "pending" (no one), with per-instance results. */
export type GroupOutcome = {
  status: "sent" | "answered" | "partial" | "pending";
  groupId: string;
  appendToken: string;
  instances: {
    taskId: string;
    appendToken: string;
    recipient?: { publicId: string; name?: string };
    result?: InstanceResult;
  }[];
};

/** One notification's answer state after an optional wait. */
export type NotificationResult = { status: "answered"; answer: Answer } | { status: "pending" } | { status: "delivered" };

export type NotificationSendResult =
  | { notificationId: string; result?: NotificationResult }
  | {
      groupId: string;
      notifications: { notificationId: string; recipient?: { publicId: string; name?: string }; result?: NotificationResult }[];
    };

export type CancelOutcome =
  | { status: "canceled"; taskId: string }
  | { status: "canceled"; subtaskId: string }
  | { status: "canceled"; groupId: string; canceled: number; skipped: number };

export type SubtaskOutcome =
  | { status: "appended"; subtaskId: string; taskId: string }
  | { status: "appended"; groupId: string; subtasks: { taskId: string; subtaskId: string }[] };


/** Org sends need exactly one target; personal sends target self or a topic. */
export type Target = { topic?: string; member?: string; broadcast?: boolean };


const DEFAULT_POLL_INTERVAL_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function keysAsDerived(keys: KeysConfig | undefined): Promise<DerivedKey[]> {
  if (keys === undefined) return [];
  const items = Array.isArray(keys) && !(keys instanceof Uint8Array) ? keys : [keys as PersonalKeyInput];
  return Promise.all(items.map((item) => (Array.isArray(item) && !(item instanceof Uint8Array) ? importKey(item[0]) : importKey(item as PersonalKeyInput))));
}

export class Simplepush {
  readonly client: Client | OrgClient;
  private readonly opts: SimplepushOptions;
  /** Decrypts polled answers. Built lazily — the keyring is only needed once
   * an encrypted value actually comes back. */
  private keyringPromise: Promise<Keyring> | undefined;

  constructor(opts: SimplepushOptions) {
    this.opts = opts;
    this.client =
      opts.mode.kind === "org"
        ? opts.mode.client
        : new Client({
            ...opts.mode.credential,
            baseUrl: opts.baseUrl,
            ...(opts.mode.keys !== undefined ? { keys: opts.mode.keys } : {}),
          });
  }

  get orgMode(): boolean {
    return this.opts.mode.kind === "org";
  }

  /** Whether org sends will be encrypted (personal depends on per-topic keys). */
  get orgEncrypts(): boolean {
    return this.client instanceof OrgClient && this.client.orgEncryptionEnabled;
  }

  async close(): Promise<void> {
    await this.client.close();
  }




  private authHeaders(): Record<string, string> {
    const mode = this.opts.mode;
    if (mode.kind === "org") return { Authorization: `Bearer ${mode.client.bearerToken}` };
    return "apiToken" in mode.credential
      ? { "API-Token": mode.credential.apiToken }
      : { Authorization: `Bearer ${mode.credential.accessToken}` };
  }

  keyring(): Promise<Keyring> {
    if (!this.keyringPromise) {
      const mode = this.opts.mode;
      this.keyringPromise =
        mode.kind === "org"
          ? mode.client.keyring()
          : keysAsDerived(mode.keys).then((personalKeys) => Keyring.build({ passwords: [], topics: [], personalKeys }));
    }
    return this.keyringPromise;
  }

  /** Enforced here as well as server-side so the model gets a sentence it can
   * act on instead of a 400. */
  private checkTarget(target: Target): void {
    const set = [target.topic, target.member, target.broadcast ? "broadcast" : undefined].filter(
      (t) => t !== undefined,
    ).length;
    if (this.opts.mode.kind === "org") {
      if (set !== 1) throw new Error("An org send needs exactly one target: topic, member, or broadcast.");
    } else {
      if (target.member !== undefined || target.broadcast) {
        throw new Error("member/broadcast targeting needs an organization credential (an integration token, or the hosted connector signed in as an organization admin); this server runs as a personal user.");
      }
    }
  }

  /** Sends a notification and returns its id (one per recipient for a group). */
  async sendNotification(
    opts: {
      content: string;
      title?: string;
      input?: NotificationInput;
      imageUrl?: string;
      audioUrl?: string;
      link?: string;
      shared?: boolean;
      /** Seconds to poll for the input answer(s); 0 returns right after sending. */
      waitSeconds?: number;
    } & Target,
  ): Promise<NotificationSendResult> {
    const { content, title, input, imageUrl, audioUrl, link, shared, waitSeconds = 0, ...target } = opts;
    this.checkTarget(target);
    const resolvedInput: NotificationInput | undefined = input;
    const body = {
      content,
      ...(title !== undefined ? { title } : {}),
      ...(resolvedInput !== undefined ? { input: resolvedInput } : {}),
      ...(imageUrl !== undefined ? { image: imageUrl } : {}),
      ...(audioUrl !== undefined ? { audio: audioUrl } : {}),
      ...(link !== undefined ? { link } : {}),
    };
    // The SDK overloads discriminate on the target shape, so the cases are
    // separate calls. `shared: true` keeps a multi-recipient send ONE
    // notification rather than one per holder — "tell the team" semantics.
    // Platform default: an independent copy per recipient (a group). `shared:
    // true` is the opt-in for one notification everyone sees — there, one
    // recipient's input answer resolves it for all.
    const mode = { shared: shared === true };
    let sent: { notificationId: string } | { groupId: string; instances: readonly { notificationId: string; recipient?: { publicId: string; name?: string | null } }[] };
    if (this.client instanceof OrgClient) {
      if (target.topic !== undefined) sent = await this.client.sendNotification({ ...body, topic: target.topic, ...mode });
      else if (target.member !== undefined) sent = await this.client.sendNotification({ ...body, member: target.member, ...mode });
      else sent = await this.client.sendNotification({ ...body, broadcast: true, ...mode });
    } else {
      if (target.topic !== undefined) sent = await this.client.sendNotification({ ...body, topic: target.topic, ...mode });
      else sent = await this.client.sendNotification(body);
    }
    const ids = "groupId" in sent ? sent.instances.map((i) => i.notificationId) : [sent.notificationId];
    // Waiting only means something when there is an input to answer.
    const results = resolvedInput !== undefined ? await this.awaitNotificationAnswers(ids, waitSeconds) : new Map<string, NotificationResult>();
    const resultOf = (id: string) => {
      const r = results.get(id);
      return r !== undefined ? { result: r } : {};
    };
    if ("groupId" in sent) {
      return {
        groupId: sent.groupId,
        notifications: sent.instances.map((inst) => ({
          notificationId: inst.notificationId,
          ...(inst.recipient !== undefined
            ? { recipient: { publicId: inst.recipient.publicId, ...(inst.recipient.name != null ? { name: inst.recipient.name } : {}) } }
            : {}),
          ...resultOf(inst.notificationId),
        })),
      };
    }
    return { notificationId: sent.notificationId, ...resultOf(sent.notificationId) };
  }

  /** Polls each notification's answer until all are in or the budget is
   * spent; a zero budget yields no results at all. */
  private async awaitNotificationAnswers(ids: string[], waitSeconds: number): Promise<Map<string, NotificationResult>> {
    const results = new Map<string, NotificationResult>();
    const budget = Math.min(waitSeconds, this.opts.maxWaitSeconds) * 1000;
    if (budget <= 0 || ids.length === 0) return results;
    const deadline = Date.now() + budget;
    const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let pending = [...ids];
    while (pending.length > 0 && Date.now() < deadline) {
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      const still: string[] = [];
      for (const id of pending) {
        const outcome = await this.getNotificationAnswer(id);
        if (outcome.status === "answered") results.set(id, { status: "answered", answer: outcome.answer });
        else if (outcome.status === "delivered") results.set(id, { status: "delivered" });
        else still.push(id);
      }
      pending = still;
    }
    for (const id of pending) results.set(id, { status: "pending" });
    return results;
  }

  /** Sends a task, then polls for the answer for up to `waitSeconds`.
   *
   * Polling rather than holding the event WebSocket open: it keeps every
   * request independent (no shared state, revocation effective immediately,
   * no socket per in-flight call), and the latency cost is invisible next to
   * a human reaching for their phone. A timeout returns `pending`, not an
   * error — the task stays live and `getTaskAnswer` picks it up later.
   */
  async sendTask(opts: SendOptions & { waitSeconds: number } & Target): Promise<AskOutcome | GroupOutcome> {
    const { waitSeconds, topic, member, broadcast, shared, ...body } = opts;
    const target: Target = { ...(topic !== undefined ? { topic } : {}), ...(member !== undefined ? { member } : {}), ...(broadcast ? { broadcast } : {}) };
    this.checkTarget(target);
    if (body.content === undefined && (body.inputs?.length ?? 0) === 0) throw new Error("A task needs content or at least one input.");

    // Independent mode — the platform default: one task per recipient, tied
    // by a group. Waiting here means waiting for EVERY copy's answer, up to
    // the deadline, then reporting per-recipient results with the rest
    // pending. A topicless personal send reaches only the sender, so it has
    // no group form and falls through to the single-task path below.
    if (shared !== true && (this.client instanceof OrgClient || target.topic !== undefined)) {
      const group =
        this.client instanceof OrgClient
          ? target.topic !== undefined
            ? await this.client.sendTask({ ...body, topic: target.topic, shared: false })
            : target.member !== undefined
              ? await this.client.sendTask({ ...body, member: target.member, shared: false })
              : await this.client.sendTask({ ...body, broadcast: true, shared: false })
          : await this.client.sendTask({ ...body, topic: target.topic as string, shared: false });
      const instances = group.instances.map((inst) => ({
        taskId: inst.taskId,
        appendToken: inst.appendToken,
        ...(inst.recipient !== undefined
          ? { recipient: { publicId: inst.recipient.publicId, ...(inst.recipient.name != null ? { name: inst.recipient.name } : {}) } }
          : {}),
      }));
      const budget = Math.min(waitSeconds, this.opts.maxWaitSeconds) * 1000;
      if (budget <= 0 || instances.length === 0) {
        return { status: "sent", groupId: group.groupId, appendToken: group.appendToken, instances };
      }
      const deadline = Date.now() + budget;
      const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const results = new Map<string, InstanceResult>();
      let pending = instances.map((i) => i.taskId);
      while (pending.length > 0 && Date.now() < deadline) {
        await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
        const still: string[] = [];
        for (const taskId of pending) {
          const outcome = await this.getTaskAnswer(taskId);
          if (outcome.status === "answered") results.set(taskId, { status: "answered", answers: outcome.answers });
          else if (outcome.status === "closed") results.set(taskId, { status: "closed", reason: outcome.reason });
          else still.push(taskId);
        }
        pending = still;
      }
      const answered = instances.filter((i) => results.get(i.taskId)?.status === "answered").length;
      return {
        status: pending.length === 0 ? "answered" : answered > 0 || results.size > 0 ? "partial" : "pending",
        groupId: group.groupId,
        appendToken: group.appendToken,
        instances: instances.map((i) => ({ ...i, result: results.get(i.taskId) ?? { status: "pending" } })),
      };
    }

    let task: { taskId: string; appendToken: string };
    if (this.client instanceof OrgClient) {
      task =
        target.topic !== undefined
          ? await this.client.sendTask({ ...body, topic: target.topic, shared: true })
          : target.member !== undefined
            ? await this.client.sendTask({ ...body, member: target.member, shared: true })
            : await this.client.sendTask({ ...body, broadcast: true, shared: true });
    } else {
      task =
        target.topic !== undefined
          ? await this.client.sendTask({ ...body, topic: target.topic, shared: true })
          : await this.client.sendTask({ ...body, shared: true });
    }
    if (waitSeconds <= 0) return { status: "pending", taskId: task.taskId, appendToken: task.appendToken };

    const budgetMs = Math.min(waitSeconds, this.opts.maxWaitSeconds) * 1000;
    const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + budgetMs;

    // A recipient can only answer after delivery, so the first poll is
    // deferred by one interval rather than fired immediately.
    while (Date.now() < deadline) {
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      const outcome = await this.getTaskAnswer(task.taskId);
      if (outcome.status !== "pending") return { ...outcome, appendToken: task.appendToken };
    }
    return { status: "pending", taskId: task.taskId, appendToken: task.appendToken };
  }

  /** Appends a follow-up to a task's chain — a task-kind token targets one
   * task, a group-kind token every instance of the group (narrowed by
   * `instances`). The token is the capability; nothing else authorises an
   * append. */
  async appendSubtask(opts: SendSubtaskOptions & { appendToken: string; instances?: string[] }): Promise<SubtaskOutcome> {
    const { appendToken, instances, ...data } = opts;
    if (data.content === undefined && (data.inputs?.length ?? 0) === 0) throw new Error("A subtask needs content or at least one input.");
    const resp = await this.client.appendSubtask({ appendToken, ...(instances !== undefined ? { instances } : {}), ...data });
    return isSubtaskGroupResponse(resp)
      ? { status: "appended", groupId: resp.groupId, subtasks: resp.subtasks }
      : { status: "appended", subtaskId: resp.subtaskId, taskId: resp.taskId };
  }

  /** Withdraws a task, subtask or whole group, routed by the id's prefix.
   * The SDK seals the note under the target's key when this server holds it. */
  async cancel(opts: { id: string; reason?: CancelReason; note?: string; supersededBy?: string }): Promise<CancelOutcome> {
    const { id, reason, note, supersededBy } = opts;
    const cancelOpts = {
      reason: reason ?? (supersededBy !== undefined ? ("superseded" as const) : ("canceled" as const)),
      ...(note !== undefined ? { note } : {}),
      ...(supersededBy !== undefined ? { supersededBy } : {}),
    };
    if (id.startsWith("grptsk_")) {
      const result = await this.client.cancelTaskGroup(id, cancelOpts);
      return { status: "canceled", groupId: id, canceled: result.canceled, skipped: result.skipped };
    }
    if (id.startsWith("sub_")) {
      await this.client.cancelSubtask(id, cancelOpts);
      return { status: "canceled", subtaskId: id };
    }
    await this.client.cancelTask(id, cancelOpts);
    return { status: "canceled", taskId: id };
  }

  /** Resolves a task or subtask by id — a cheap point read, no subscription —
   * and decrypts the answers the payload carries. */
  async getTaskAnswer(id: string): Promise<AskOutcome> {
    const subtask = id.startsWith("sub_");
    const payload = subtask ? await this.client.getSubtask(id) : await this.client.getTask(id);
    const { value, undecryptable } = await decryptTaskPayload(payload, await this.keyring());
    const p = value as { status: string; parentTaskId?: string; uploads?: Record<string, unknown>[] };
    const ids = subtask ? { taskId: p.parentTaskId ?? "", subtaskId: id } : { taskId: id };
    switch (p.status) {
      case "completed":
        return {
          status: "answered",
          ...ids,
          answers: (p.uploads ?? []).map(answerOf),
          ...(undecryptable > 0 ? { undecryptable } : {}),
        };
      case "pending":
        return { status: "pending", ...ids };
      default:
        return { status: "closed", ...ids, reason: p.status };
    }
  }

  /** Resolves a notification by id — the notification twin of getTaskAnswer.
   * A notification without an input is "delivered" (nothing to answer); one
   * with an input reports what the recipient entered, decrypted where this
   * server holds the key. */
  async getNotificationAnswer(notificationId: string): Promise<NotificationOutcome> {
    const payload = await this.client.getNotification(notificationId);
    if (payload.input === undefined) return { status: "delivered", notificationId };
    const { reply } = payload;
    if (payload.status !== "completed" || reply === undefined) return { status: "pending", notificationId };
    const { value, undecryptable } = await decryptNotificationPayload({ ...payload, reply }, await this.keyring());
    return { status: "answered", notificationId, answer: answerOf(value.reply), ...(undecryptable > 0 ? { undecryptable } : {}) };
  }

}

/** Flattens an answer record (upload or notification reply) to kind + value. */
function answerOf(r: Record<string, unknown>): Answer {
  if (r.type === "file") {
    return {
      kind: "file",
      inputId: String(r.inputId),
      ...(typeof r.filename === "string" ? { filename: r.filename } : {}),
      ...(typeof r.contentType === "string" ? { contentType: r.contentType } : {}),
      ...(typeof r.size === "number" ? { size: r.size } : {}),
      ...(typeof r.durationSeconds === "number" ? { durationSeconds: r.durationSeconds } : {}),
    };
  }
  const raw = r.value ?? r.selectedValue ?? r.selectedKey ?? (Array.isArray(r.selectedValues) ? r.selectedValues.join(", ") : undefined);
  return typeof raw === "string" ? { kind: String(r.type), value: raw } : { kind: String(r.type) };
}

/** HTTP failures as sentences a model can act on rather than bare statuses. */
/** The backend's error body: `{"error": "<code>", "msg": "<detail>"}`; both
 * absent when the body is not that JSON. */
export function parseErrorBody(body: string): { code?: string; msg?: string } {
  try {
    const { error, msg } = JSON.parse(body) as { error?: unknown; msg?: unknown };
    return { ...(typeof error === "string" ? { code: error } : {}), ...(typeof msg === "string" ? { msg } : {}) };
  } catch {
    return {};
  }
}

export function failureText(status: number, body: string): string {
  switch (status) {
    case 401:
      return "The credential was rejected — invalid, revoked, not for this backend, or not allowed this operation.";
    case 403:
      return body.includes("subscription_required")
        ? "The task, event and submission query endpoints need a Simplepush subscription. Sending, asking, waiting for answers and the live event stream stay free."
        : body.includes("insufficient_scope")
          ? "The credential does not carry the scope this needs ('read' for queries, 'files:read' for downloads)."
          : "Not allowed: the object does not belong to this account.";
    case 404: {
      // The backend's message often carries the actionable detail (e.g.
      // "no topic 'x' in this org"); keep it when it parses.
      const { msg } = parseErrorBody(body);
      return msg !== undefined ? `Not found: ${msg}.` : "Not found. Check the id.";
    }
    default:
      return `HTTP ${status}${body ? `: ${body}` : ""}.`;
  }
}

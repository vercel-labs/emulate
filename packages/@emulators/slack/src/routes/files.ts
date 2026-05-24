import type { Context, RouteContext } from "@emulators/core";
import type {
  SlackChannel,
  SlackFile,
  SlackFileShare,
  SlackFileUploadSession,
  SlackJsonObject,
  SlackMessage,
  SlackUser,
} from "../entities.js";
import { getSlackStore } from "../store.js";
import {
  formatSlackFile,
  formatSlackMessage,
  generateSlackId,
  generateTs,
  parseSlackBody,
  requireSlackScopes,
  slackError,
  slackOk,
} from "../helpers.js";

export function filesRoutes(ctx: RouteContext): void {
  const { app, store, webhooks, baseUrl } = ctx;
  const ss = () => getSlackStore(store);
  const serviceBaseUrl = baseUrl.replace(/\/$/, "");
  const getAuthSlackUser = (authUser: { login: string }) =>
    ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login);
  const getAuthUserId = (authUser: { login: string }) => getAuthSlackUser(authUser)?.user_id ?? authUser.login;
  const isChannelMember = (channel: SlackChannel, user: SlackUser | undefined, userId: string) =>
    channel.members.includes(userId) || (user ? channel.members.includes(user.name) : false);
  const canReadConversation = (channel: SlackChannel, user: SlackUser | undefined, userId: string) =>
    !channel.is_private || isChannelMember(channel, user, userId);
  const visibleFileChannelIds = (file: SlackFile, authUser: { login: string }) => {
    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = authSlackUser?.user_id ?? authUser.login;
    return fileChannels(file).filter((channelId) => {
      const channel = ss().channels.findOneBy("channel_id", channelId);
      return channel ? canReadConversation(channel, authSlackUser, authUserId) : false;
    });
  };
  const canAccessFile = (file: SlackFile, authUser: { login: string }) => {
    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = authSlackUser?.user_id ?? authUser.login;
    if (file.user === authUserId || (authSlackUser && file.user === authSlackUser.name)) return true;
    return visibleFileChannelIds(file, authUser).length > 0;
  };
  const canAccessFileInChannel = (file: SlackFile, authUser: { login: string }, channelId: string) => {
    return visibleFileChannelIds(file, authUser).includes(channelId);
  };
  const formatSlackFileForAuth = (file: SlackFile, authUser: { login: string }) => {
    const visibleIds = new Set(visibleFileChannelIds(file, authUser));
    const publicShares = filterVisibleShares(file.shares.public, visibleIds);
    const privateShares = filterVisibleShares(file.shares.private, visibleIds);
    const shares: SlackFile["shares"] = {};
    if (publicShares) shares.public = publicShares;
    if (privateShares) shares.private = privateShares;

    return formatSlackFile({
      ...file,
      channels: file.channels.filter((channelId) => visibleIds.has(channelId)),
      groups: file.groups.filter((channelId) => visibleIds.has(channelId)),
      ims: file.ims.filter((channelId) => visibleIds.has(channelId)),
      shares,
    });
  };
  const canDeleteFile = (file: SlackFile, authUser: { login: string }) => {
    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = authSlackUser?.user_id ?? authUser.login;
    return file.user === authUserId || authSlackUser?.is_admin === true;
  };
  const findChannel = (channel: string) =>
    ss().channels.findOneBy("channel_id", channel) ??
    ss()
      .channels.all()
      .find((ch) => !ch.is_im && !ch.is_mpim && ch.name === channel);

  const findOrCreateDirectMessage = (authUser: { login: string }, userId: string) => {
    const targetUser = ss().users.findOneBy("user_id", userId);
    if (!targetUser || targetUser.deleted) return undefined;

    const authUserId = getAuthUserId(authUser);
    if (targetUser.user_id === authUserId) return undefined;

    const members = [authUserId, targetUser.user_id].sort();
    const existing = ss()
      .channels.all()
      .find(
        (ch) =>
          ch.is_im && ch.members.length === members.length && [...ch.members].sort().join(",") === members.join(","),
      );
    if (existing) return existing;

    const team = ss().teams.all()[0];
    const now = Math.floor(Date.now() / 1000);
    return ss().channels.insert({
      channel_id: generateSlackId("D"),
      team_id: team?.team_id ?? "T000000001",
      name: targetUser.name,
      is_channel: false,
      is_private: true,
      is_im: true,
      is_mpim: false,
      is_open_by_user: { [authUserId]: true },
      user: targetUser.user_id,
      is_archived: false,
      topic: { value: "", creator: authUserId, last_set: now },
      purpose: { value: "", creator: authUserId, last_set: now },
      members,
      creator: authUserId,
      num_members: members.length,
      last_read: {},
    });
  };

  const findShareTarget = (authUser: { login: string }, channel: string) =>
    findChannel(channel) ?? (channel.startsWith("U") ? findOrCreateDirectMessage(authUser, channel) : undefined);

  app.post("/api/files.getUploadURLExternal", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["files:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    const length = Number(body.length);
    const altTxt = typeof body.alt_text === "string" ? body.alt_text : undefined;
    const snippetType = typeof body.snippet_type === "string" ? body.snippet_type : undefined;

    if (!filename || !Number.isFinite(length) || length < 0) return slackError(c, "invalid_arguments");

    const team = ss().teams.all()[0];
    const fileId = generateSlackId("F");
    const uploadUrl = `${serviceBaseUrl}/upload/v1/${fileId}`;
    ss().fileUploadSessions.insert({
      file_id: fileId,
      team_id: team?.team_id ?? "T000000001",
      user: getAuthUserId(authUser),
      filename,
      title: filename,
      length: Math.floor(length),
      upload_url: uploadUrl,
      alt_txt: altTxt,
      snippet_type: snippetType,
      uploaded: false,
      completed: false,
    });

    return slackOk(c, { upload_url: uploadUrl, file_id: fileId });
  });

  app.post("/upload/v1/:fileId", async (c) => {
    const session = ss().fileUploadSessions.findOneBy("file_id", c.req.param("fileId"));
    if (!session || session.completed) return c.text("file_not_found", 404);

    const data = await readUploadBytes(c);
    if (!data) return c.text("invalid_upload", 400);

    ss().fileUploadSessions.update(session.id, {
      uploaded: true,
      uploaded_size: data.byteLength,
      content_base64: data.toString("base64"),
    });
    return c.text("OK");
  });

  app.post("/api/files.completeUploadExternal", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["files:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const requestedFiles = parseCompleteFiles(body.files);
    if (requestedFiles.length === 0) return slackError(c, "invalid_arguments");
    if (new Set(requestedFiles.map((file) => file.id)).size !== requestedFiles.length) {
      return slackError(c, "invalid_arguments");
    }

    const authUserId = getAuthUserId(authUser);
    const rawChannelIds = parseDestinationChannels(body.channel_id, body.channels);
    const targets: SlackChannel[] = [];
    for (const channelId of rawChannelIds) {
      const channel = findShareTarget(authUser, channelId);
      if (!channel) return slackError(c, "channel_not_found");
      if (channel.is_archived) return slackError(c, "is_archived");
      if (!canReadConversation(channel, getAuthSlackUser(authUser), authUserId)) return slackError(c, "not_in_channel");
      targets.push(channel);
    }

    const initialComment = typeof body.initial_comment === "string" ? body.initial_comment : "";
    const threadTs = typeof body.thread_ts === "string" ? body.thread_ts : undefined;
    const blocks = parseBlocks(body.blocks);
    if (body.blocks !== undefined && blocks === undefined) return slackError(c, "invalid_blocks");

    const requestedSessions: SlackFileUploadSession[] = [];
    for (const requestedFile of requestedFiles) {
      const session = ss().fileUploadSessions.findOneBy("file_id", requestedFile.id);
      if (!session || !session.uploaded || session.completed || session.user !== authUserId) {
        return slackError(c, "file_not_found");
      }
      requestedSessions.push(session);
    }

    const completedFiles: SlackFile[] = [];
    for (let index = 0; index < requestedFiles.length; index++) {
      const requestedFile = requestedFiles[index];
      const session = requestedSessions[index];
      const file = ss().files.insert(
        buildSlackFile(session, {
          title: requestedFile.title ?? session.title,
          user: authUserId,
          baseUrl: serviceBaseUrl,
          initialComment,
          threadTs,
        }),
      );
      ss().fileUploadSessions.update(session.id, { completed: true });
      await dispatchFileEvent(webhooks, "file_created", file);
      completedFiles.push(file);
    }

    const sharedFiles = targets.length > 0 ? await shareFiles(targets, completedFiles) : completedFiles;
    return slackOk(c, { files: sharedFiles.map((file) => formatSlackFileForAuth(file, authUser)) });

    async function shareFiles(channels: SlackChannel[], files: SlackFile[]) {
      const updatedFiles = [...files];
      for (const channel of channels) {
        const msg = ss().messages.insert({
          ts: generateTs(),
          channel_id: channel.channel_id,
          user: authUserId,
          text: initialComment,
          type: "message" as const,
          subtype: "file_share",
          thread_ts: threadTs,
          blocks,
          files: updatedFiles,
          upload: true,
          reply_count: 0,
          reply_users: [],
          reactions: [],
        });

        updateParentThread(channel.channel_id, threadTs, authUserId);

        const messageFiles: SlackFile[] = [];
        for (const file of updatedFiles) {
          const shared = updateFileShare(file, channel, msg, authUserId);
          messageFiles.push(shared);
          await dispatchFileEvent(webhooks, "file_shared", shared, { channel_id: channel.channel_id });
        }

        const updatedMessage = ss().messages.update(msg.id, { files: messageFiles })!;
        await webhooks.dispatch(
          "message",
          undefined,
          {
            type: "event_callback",
            event: {
              ...formatSlackMessage(updatedMessage),
              type: "message",
              subtype: "file_share",
              channel: channel.channel_id,
            },
          },
          "slack",
        );

        for (const shared of messageFiles) {
          const index = updatedFiles.findIndex((file) => file.file_id === shared.file_id);
          if (index >= 0) updatedFiles[index] = shared;
        }
      }
      return updatedFiles;
    }
  });

  async function fileInfo(c: Context) {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["files:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackRequest(c);
    const fileId = typeof body.file === "string" ? body.file : "";
    const file = fileId ? ss().files.findOneBy("file_id", fileId) : undefined;
    if (!file || file.deleted || !canAccessFile(file, authUser)) return slackError(c, "file_not_found");

    return slackOk(c, {
      file: formatSlackFileForAuth(file, authUser),
      comments: [],
      paging: { count: 0, total: 0, page: 1, pages: 0 },
    });
  }

  async function fileList(c: Context) {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["files:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackRequest(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const user = typeof body.user === "string" ? body.user : "";
    const types = typeof body.types === "string" ? body.types : "all";
    const tsFrom = body.ts_from === undefined ? undefined : Number(body.ts_from);
    const tsTo = body.ts_to === undefined ? undefined : Number(body.ts_to);
    const page = Math.max(1, Math.floor(Number(body.page) || 1));
    const count = Math.min(Math.max(1, Math.floor(Number(body.count) || 100)), 1000);

    const files = ss()
      .files.all()
      .filter((file) => !file.deleted)
      .filter((file) => canAccessFile(file, authUser))
      .filter((file) => !channel || canAccessFileInChannel(file, authUser, channel))
      .filter((file) => !user || file.user === user)
      .filter((file) => tsFrom === undefined || file.created >= tsFrom)
      .filter((file) => tsTo === undefined || file.created <= tsTo)
      .filter((file) => matchesFileTypes(file, types))
      .sort((a, b) => b.created - a.created || b.file_id.localeCompare(a.file_id));

    const start = (page - 1) * count;
    const paged = files.slice(start, start + count);
    return slackOk(c, {
      files: paged.map((file) => formatSlackFileForAuth(file, authUser)),
      paging: {
        count,
        total: files.length,
        page,
        pages: Math.ceil(files.length / count),
      },
    });
  }

  app.get("/api/files.info", fileInfo);
  app.post("/api/files.info", fileInfo);
  app.get("/api/files.list", fileList);
  app.post("/api/files.list", fileList);

  app.get("/files-pri/:fileId/:filename", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return c.text("not_authed", 401);
    const scopeError = requireSlackScopes(c, store, ["files:read"]);
    if (scopeError) return scopeError;

    const file = ss().files.findOneBy("file_id", c.req.param("fileId"));
    if (!file || file.deleted) return c.text("file_not_found", 404);
    if (!canAccessFile(file, authUser)) return c.text("file_not_found", 404);

    const data = Buffer.from(file.content_base64 ?? "", "base64");
    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": file.mimetype,
        ...(c.req.query("download") ? { "Content-Disposition": `attachment; filename="${file.name}"` } : {}),
      },
    });
  });

  app.post("/api/files.delete", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["files:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const fileId = typeof body.file === "string" ? body.file : "";
    const file = fileId ? ss().files.findOneBy("file_id", fileId) : undefined;
    if (!file || file.deleted || !canAccessFile(file, authUser)) return slackError(c, "file_not_found");
    if (!canDeleteFile(file, authUser)) return slackError(c, "cant_delete_file");

    const deleted = ss().files.update(file.id, { deleted: true })!;
    removeFileFromMessages(deleted.file_id);
    await dispatchFileEvent(webhooks, "file_deleted", deleted);
    return slackOk(c, {});
  });

  function removeFileFromMessages(fileId: string) {
    for (const message of ss().messages.all()) {
      if (!message.files?.some((file) => file.file_id === fileId)) continue;
      ss().messages.update(message.id, {
        files: message.files.filter((file) => file.file_id !== fileId),
      });
    }
  }

  function updateParentThread(channelId: string, threadTs: string | undefined, userId: string) {
    if (!threadTs) return;
    const parent = ss()
      .messages.all()
      .find((message) => message.channel_id === channelId && message.ts === threadTs);
    if (!parent) return;

    const replyUsers = parent.reply_users.includes(userId) ? parent.reply_users : [...parent.reply_users, userId];
    ss().messages.update(parent.id, {
      reply_count: parent.reply_count + 1,
      reply_users: replyUsers,
    });
  }

  function updateFileShare(file: SlackFile, channel: SlackChannel, msg: SlackMessage, userId: string): SlackFile {
    const share: SlackFileShare = {
      ts: msg.ts,
      channel_name: channel.name,
      team_id: channel.team_id,
      share_user_id: userId,
      source: "UPLOAD",
      thread_ts: msg.thread_ts,
      reply_count: 0,
      reply_users: [],
      reply_users_count: 0,
      is_silent_share: false,
    };
    const shareBucket = channel.is_private ? "private" : "public";
    const shares = {
      ...file.shares,
      [shareBucket]: {
        ...(file.shares[shareBucket] ?? {}),
        [channel.channel_id]: [...(file.shares[shareBucket]?.[channel.channel_id] ?? []), share],
      },
    };
    const channelFields = nextFileChannelFields(file, channel);
    return ss().files.update(file.id, {
      ...channelFields,
      shares,
      is_public: channelFields.channels.length > 0,
    })!;
  }
}

async function parseSlackRequest(c: Context): Promise<Record<string, unknown>> {
  if (c.req.method === "GET") {
    return Object.fromEntries(new URL(c.req.url).searchParams.entries());
  }
  return parseSlackBody(c);
}

async function readUploadBytes(c: Context): Promise<Buffer | undefined> {
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return Buffer.from(await c.req.arrayBuffer());
  }

  const body = await c.req.parseBody();
  const value = firstFormValue(body.body);
  if (value === undefined) return undefined;
  return formValueToBuffer(value);
}

function firstFormValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

async function formValueToBuffer(value: unknown): Promise<Buffer | undefined> {
  if (typeof value === "string") return Buffer.from(value);
  if (value && typeof value === "object" && "arrayBuffer" in value) {
    const arrayBuffer = (value as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer;
    if (typeof arrayBuffer === "function") return Buffer.from(await arrayBuffer.call(value));
  }
  return undefined;
}

function parseCompleteFiles(value: unknown): Array<{ id: string; title?: string; highlight_type?: string }> {
  const parsed = parseJsonMaybe(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      title: typeof entry.title === "string" ? entry.title : undefined,
      highlight_type: typeof entry.highlight_type === "string" ? entry.highlight_type : undefined,
    }))
    .filter((entry) => entry.id);
}

function parseDestinationChannels(channelId: unknown, channels: unknown): string[] {
  const values: string[] = [];
  if (typeof channelId === "string" && channelId.trim()) values.push(channelId.trim());
  if (typeof channels === "string" && channels.trim()) {
    values.push(...channels.split(",").map((channel) => channel.trim()));
  }
  return [...new Set(values.filter(Boolean))];
}

function parseBlocks(value: unknown): SlackJsonObject[] | undefined {
  const parsed = parseJsonMaybe(value);
  if (parsed === undefined || parsed === "") return undefined;
  if (!Array.isArray(parsed)) return undefined;
  if (!parsed.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) return undefined;
  return parsed as SlackJsonObject[];
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function buildSlackFile(
  session: {
    file_id: string;
    team_id: string;
    filename: string;
    length: number;
    alt_txt?: string;
    snippet_type?: string;
    content_base64?: string;
    uploaded_size?: number;
  },
  options: {
    title: string;
    user: string;
    baseUrl: string;
    initialComment?: string;
    threadTs?: string;
  },
): Omit<SlackFile, "id" | "created_at" | "updated_at"> {
  const created = Math.floor(Date.now() / 1000);
  const fileType = fileTypeFor(session.filename, session.snippet_type);
  const root = options.baseUrl.replace(/\/$/, "");
  return {
    file_id: session.file_id,
    team_id: session.team_id,
    user: options.user,
    name: session.filename,
    title: options.title || session.filename,
    mimetype: mimeTypeFor(session.filename, session.snippet_type),
    filetype: fileType,
    pretty_type: prettyTypeFor(fileType),
    mode: session.snippet_type ? "snippet" : "hosted",
    size: session.uploaded_size ?? session.length,
    created,
    timestamp: created,
    url_private: `${root}/files-pri/${session.file_id}/${encodeURIComponent(session.filename)}`,
    url_private_download: `${root}/files-pri/${session.file_id}/${encodeURIComponent(session.filename)}?download=1`,
    permalink: `${root}/files/${session.file_id}`,
    is_external: false,
    external_type: "",
    is_public: false,
    public_url_shared: false,
    display_as_bot: false,
    editable: session.snippet_type !== undefined,
    deleted: false,
    channels: [],
    groups: [],
    ims: [],
    shares: {},
    initial_comment: options.initialComment || undefined,
    thread_ts: options.threadTs,
    alt_txt: session.alt_txt,
    snippet_type: session.snippet_type,
    content_base64: session.content_base64,
  };
}

function nextFileChannelFields(file: SlackFile, channel: SlackChannel) {
  const channels = new Set(file.channels);
  const groups = new Set(file.groups);
  const ims = new Set(file.ims);

  if (channel.is_im || channel.is_mpim) ims.add(channel.channel_id);
  else if (channel.is_private) groups.add(channel.channel_id);
  else channels.add(channel.channel_id);

  return { channels: [...channels], groups: [...groups], ims: [...ims] };
}

function fileChannels(file: SlackFile): string[] {
  return [...file.channels, ...file.groups, ...file.ims];
}

function filterVisibleShares(shares: Record<string, SlackFileShare[]> | undefined, visibleIds: Set<string>) {
  const entries = Object.entries(shares ?? {}).filter(([channelId]) => visibleIds.has(channelId));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function matchesFileTypes(file: SlackFile, types: string): boolean {
  const requested = types
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  if (requested.length === 0 || requested.includes("all")) return true;
  if (requested.includes(file.filetype)) return true;
  if (requested.includes("snippets") && file.mode === "snippet") return true;
  if (requested.includes("images") && file.mimetype.startsWith("image/")) return true;
  if (requested.includes("zips") && file.filetype === "zip") return true;
  if (requested.includes("pdfs") && file.filetype === "pdf") return true;
  return false;
}

function fileTypeFor(filename: string, snippetType?: string): string {
  if (snippetType) return snippetType;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!ext || ext === filename) return "auto";
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "md" || ext === "markdown") return "markdown";
  return ext;
}

function mimeTypeFor(filename: string, snippetType?: string): string {
  if (snippetType) return "text/plain";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = {
    gif: "image/gif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    md: "text/markdown",
    pdf: "application/pdf",
    png: "image/png",
    txt: "text/plain",
    zip: "application/zip",
  };
  return byExt[ext] ?? "application/octet-stream";
}

function prettyTypeFor(filetype: string): string {
  const byType: Record<string, string> = {
    auto: "File",
    gif: "GIF",
    jpg: "JPEG",
    markdown: "Markdown",
    pdf: "PDF",
    png: "PNG",
    txt: "Plain Text",
    zip: "Zip",
  };
  return byType[filetype] ?? filetype.toUpperCase();
}

async function dispatchFileEvent(
  webhooks: RouteContext["webhooks"],
  type: "file_created" | "file_shared" | "file_deleted",
  file: SlackFile,
  extra: Record<string, unknown> = {},
) {
  await webhooks.dispatch(
    type,
    undefined,
    {
      type: "event_callback",
      event: {
        type,
        file_id: file.file_id,
        file: formatSlackFile(file),
        ...extra,
      },
    },
    "slack",
  );
}

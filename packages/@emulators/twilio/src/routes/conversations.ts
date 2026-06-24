import type { Context, RouteContext } from "@emulators/core";
import { twilioSid } from "../ids.js";
import {
  formatConversation,
  formatConversationMessage,
  formatConversationParticipant,
  formatConversationService,
} from "../formatters.js";
import { getTwilioStore } from "../store.js";
import { bodyString, parseTwilioBody, requireTwilioAuth, twilioError, twilioList } from "../helpers.js";

export function conversationRoutes({ app, store }: RouteContext): void {
  const ts = getTwilioStore(store);

  app.get("/conversations/v1/Services", (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const services = ts.conversationServices.findBy("account_sid", account.sid);
    return twilioList(c, "services", services, "/conversations/v1/Services", formatConversationService);
  });

  app.post("/conversations/v1/Services", async (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const friendlyName = bodyString(body, "FriendlyName");
    if (!friendlyName) return twilioError(c, 400, "FriendlyName is required", 20001);
    const service = ts.conversationServices.insert({
      sid: twilioSid("IS"),
      account_sid: account.sid,
      friendly_name: friendlyName,
    });
    return c.json(formatConversationService(service), 201);
  });

  app.get("/conversations/v1/Services/:serviceSid", (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    return c.json(formatConversationService(service));
  });

  app.post("/conversations/v1/Services/:serviceSid/Conversations", async (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const body = await parseTwilioBody(c);
    const uniqueName = bodyString(body, "UniqueName") ?? null;
    if (uniqueName) {
      const existing = ts.conversations
        .findBy("service_sid", service.sid)
        .find((conversation) => conversation.unique_name === uniqueName);
      if (existing) return twilioError(c, 409, "Conversation unique name already exists", 50353);
    }
    const conversation = ts.conversations.insert({
      sid: twilioSid("CH"),
      account_sid: service.account_sid,
      service_sid: service.sid,
      friendly_name: bodyString(body, "FriendlyName") ?? null,
      unique_name: uniqueName,
      state: "active",
      attributes: bodyString(body, "Attributes") ?? "{}",
    });
    return c.json(formatConversation(conversation), 201);
  });

  app.get("/conversations/v1/Services/:serviceSid/Conversations", (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const conversations = ts.conversations.findBy("service_sid", service.sid);
    return twilioList(
      c,
      "conversations",
      conversations,
      `/conversations/v1/Services/${service.sid}/Conversations`,
      formatConversation,
    );
  });

  app.get("/conversations/v1/Services/:serviceSid/Conversations/:conversationSid", (c) => {
    const conversation = authenticatedConversation(c);
    if (conversation instanceof Response) return conversation;
    return c.json(formatConversation(conversation));
  });

  app.post("/conversations/v1/Services/:serviceSid/Conversations/:conversationSid", async (c) => {
    const conversation = authenticatedConversation(c);
    if (conversation instanceof Response) return conversation;
    const body = await parseTwilioBody(c);
    const state = bodyString(body, "State");
    if (state && !["active", "inactive", "closed"].includes(state))
      return twilioError(c, 400, "State is invalid", 20001);
    const updated = ts.conversations.update(conversation.id, {
      friendly_name: bodyString(body, "FriendlyName") ?? conversation.friendly_name,
      unique_name: bodyString(body, "UniqueName") ?? conversation.unique_name,
      attributes: bodyString(body, "Attributes") ?? conversation.attributes,
      state: (state as typeof conversation.state | undefined) ?? conversation.state,
    })!;
    return c.json(formatConversation(updated));
  });

  app.delete("/conversations/v1/Services/:serviceSid/Conversations/:conversationSid", (c) => {
    const conversation = authenticatedConversation(c);
    if (conversation instanceof Response) return conversation;
    for (const participant of ts.conversationParticipants.findBy("conversation_sid", conversation.sid)) {
      ts.conversationParticipants.delete(participant.id);
    }
    for (const message of ts.conversationMessages.findBy("conversation_sid", conversation.sid)) {
      ts.conversationMessages.delete(message.id);
    }
    ts.conversations.delete(conversation.id);
    return c.body(null, 204);
  });

  app.post("/conversations/v1/Services/:serviceSid/Conversations/:conversationSid/Participants", async (c) => {
    const conversation = authenticatedConversation(c);
    if (conversation instanceof Response) return conversation;
    const body = await parseTwilioBody(c);
    const identity = bodyString(body, "Identity") ?? null;
    const address = bodyString(body, "MessagingBinding.Address") ?? bodyString(body, "MessagingBindingAddress") ?? null;
    if (!identity && !address) return twilioError(c, 400, "Identity or MessagingBinding.Address is required", 20001);
    const participant = ts.conversationParticipants.insert({
      sid: twilioSid("MB"),
      account_sid: conversation.account_sid,
      service_sid: conversation.service_sid,
      conversation_sid: conversation.sid,
      identity,
      messaging_binding_address: address,
      messaging_binding_proxy_address:
        bodyString(body, "MessagingBinding.ProxyAddress") ?? bodyString(body, "MessagingBindingProxyAddress") ?? null,
      attributes: bodyString(body, "Attributes") ?? "{}",
    });
    return c.json(formatConversationParticipant(participant), 201);
  });

  app.get("/conversations/v1/Services/:serviceSid/Conversations/:conversationSid/Participants", (c) => {
    const conversation = authenticatedConversation(c);
    if (conversation instanceof Response) return conversation;
    const participants = ts.conversationParticipants.findBy("conversation_sid", conversation.sid);
    return twilioList(
      c,
      "participants",
      participants,
      `/conversations/v1/Services/${conversation.service_sid}/Conversations/${conversation.sid}/Participants`,
      formatConversationParticipant,
    );
  });

  app.post("/conversations/v1/Services/:serviceSid/Conversations/:conversationSid/Messages", async (c) => {
    const conversation = authenticatedConversation(c);
    if (conversation instanceof Response) return conversation;
    const body = await parseTwilioBody(c);
    const index = ts.conversationMessages.count((message) => message.conversation_sid === conversation.sid);
    const message = ts.conversationMessages.insert({
      sid: twilioSid("IM"),
      account_sid: conversation.account_sid,
      service_sid: conversation.service_sid,
      conversation_sid: conversation.sid,
      author: bodyString(body, "Author") ?? null,
      body: bodyString(body, "Body") ?? null,
      index,
      attributes: bodyString(body, "Attributes") ?? "{}",
    });
    return c.json(formatConversationMessage(message), 201);
  });

  app.get("/conversations/v1/Services/:serviceSid/Conversations/:conversationSid/Messages", (c) => {
    const conversation = authenticatedConversation(c);
    if (conversation instanceof Response) return conversation;
    const messages = ts.conversationMessages
      .findBy("conversation_sid", conversation.sid)
      .sort((a, b) => a.index - b.index);
    return twilioList(
      c,
      "messages",
      messages,
      `/conversations/v1/Services/${conversation.service_sid}/Conversations/${conversation.sid}/Messages`,
      formatConversationMessage,
    );
  });

  function authenticatedAccount(c: Context) {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    return auth;
  }

  function authenticatedService(c: Context) {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const service = ts.conversationServices.findOneBy("sid", c.req.param("serviceSid"));
    if (!service || service.account_sid !== account.sid) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    return service;
  }

  function authenticatedConversation(c: Context) {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const conversationSid = c.req.param("conversationSid");
    const conversation =
      ts.conversations.findOneBy("sid", conversationSid) ??
      ts.conversations.findBy("service_sid", service.sid).find((item) => item.unique_name === conversationSid);
    if (!conversation || conversation.service_sid !== service.sid) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    return conversation;
  }
}

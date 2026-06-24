import { Store, type Collection } from "@emulators/core";
import type {
  TwilioAccount,
  TwilioApiKey,
  TwilioApplication,
  TwilioCall,
  TwilioConversation,
  TwilioConversationMessage,
  TwilioConversationParticipant,
  TwilioConversationService,
  TwilioIncomingPhoneNumber,
  TwilioMedia,
  TwilioMessage,
  TwilioMessagingService,
  TwilioMessagingServicePhoneNumber,
  TwilioVerification,
  TwilioVerifyService,
  TwilioWebhookDelivery,
} from "./entities.js";

export interface TwilioStore {
  accounts: Collection<TwilioAccount>;
  apiKeys: Collection<TwilioApiKey>;
  applications: Collection<TwilioApplication>;
  phoneNumbers: Collection<TwilioIncomingPhoneNumber>;
  messagingServices: Collection<TwilioMessagingService>;
  messagingServicePhoneNumbers: Collection<TwilioMessagingServicePhoneNumber>;
  messages: Collection<TwilioMessage>;
  media: Collection<TwilioMedia>;
  verifyServices: Collection<TwilioVerifyService>;
  verifications: Collection<TwilioVerification>;
  calls: Collection<TwilioCall>;
  webhookDeliveries: Collection<TwilioWebhookDelivery>;
  conversationServices: Collection<TwilioConversationService>;
  conversations: Collection<TwilioConversation>;
  conversationParticipants: Collection<TwilioConversationParticipant>;
  conversationMessages: Collection<TwilioConversationMessage>;
}

export function getTwilioStore(store: Store): TwilioStore {
  return {
    accounts: store.collection<TwilioAccount>("twilio.accounts", ["sid"]),
    apiKeys: store.collection<TwilioApiKey>("twilio.api_keys", ["sid", "account_sid"]),
    applications: store.collection<TwilioApplication>("twilio.applications", ["sid", "account_sid"]),
    phoneNumbers: store.collection<TwilioIncomingPhoneNumber>("twilio.phone_numbers", [
      "sid",
      "account_sid",
      "phone_number",
    ]),
    messagingServices: store.collection<TwilioMessagingService>("twilio.messaging_services", ["sid", "account_sid"]),
    messagingServicePhoneNumbers: store.collection<TwilioMessagingServicePhoneNumber>(
      "twilio.messaging_service_phone_numbers",
      ["sid", "account_sid", "service_sid", "phone_number_sid"],
    ),
    messages: store.collection<TwilioMessage>("twilio.messages", [
      "sid",
      "account_sid",
      "to",
      "from",
      "status",
      "messaging_service_sid",
    ]),
    media: store.collection<TwilioMedia>("twilio.media", ["sid", "account_sid", "message_sid"]),
    verifyServices: store.collection<TwilioVerifyService>("twilio.verify_services", ["sid", "account_sid"]),
    verifications: store.collection<TwilioVerification>("twilio.verifications", [
      "sid",
      "service_sid",
      "account_sid",
      "to",
      "status",
    ]),
    calls: store.collection<TwilioCall>("twilio.calls", ["sid", "account_sid", "to", "from", "status"]),
    webhookDeliveries: store.collection<TwilioWebhookDelivery>("twilio.webhook_deliveries", [
      "twilio_id",
      "account_sid",
      "event",
    ]),
    conversationServices: store.collection<TwilioConversationService>("twilio.conversation_services", [
      "sid",
      "account_sid",
    ]),
    conversations: store.collection<TwilioConversation>("twilio.conversations", [
      "sid",
      "account_sid",
      "service_sid",
      "unique_name",
    ]),
    conversationParticipants: store.collection<TwilioConversationParticipant>("twilio.conversation_participants", [
      "sid",
      "account_sid",
      "service_sid",
      "conversation_sid",
      "identity",
    ]),
    conversationMessages: store.collection<TwilioConversationMessage>("twilio.conversation_messages", [
      "sid",
      "account_sid",
      "service_sid",
      "conversation_sid",
    ]),
  };
}

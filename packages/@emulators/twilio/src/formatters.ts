import type {
  TwilioAccount,
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
} from "./entities.js";
import { twilioDate } from "./helpers.js";

const API_VERSION = "2010-04-01";

export function formatAccount(account: TwilioAccount): Record<string, unknown> {
  return {
    sid: account.sid,
    date_created: twilioDate(account.created_at),
    date_updated: twilioDate(account.updated_at),
    friendly_name: account.friendly_name,
    owner_account_sid: account.owner_account_sid,
    status: account.status,
    type: account.owner_account_sid ? "SubAccount" : "Full",
    uri: `/${API_VERSION}/Accounts/${account.sid}.json`,
    subresource_uris: {
      available_phone_numbers: `/${API_VERSION}/Accounts/${account.sid}/AvailablePhoneNumbers.json`,
      calls: `/${API_VERSION}/Accounts/${account.sid}/Calls.json`,
      incoming_phone_numbers: `/${API_VERSION}/Accounts/${account.sid}/IncomingPhoneNumbers.json`,
      messages: `/${API_VERSION}/Accounts/${account.sid}/Messages.json`,
      recordings: `/${API_VERSION}/Accounts/${account.sid}/Recordings.json`,
    },
  };
}

export function formatPhoneNumber(number: TwilioIncomingPhoneNumber): Record<string, unknown> {
  return {
    sid: number.sid,
    account_sid: number.account_sid,
    friendly_name: number.friendly_name,
    phone_number: number.phone_number,
    voice_url: number.voice_url,
    voice_method: number.voice_method,
    sms_url: number.sms_url,
    sms_method: number.sms_method,
    status_callback: number.status_callback,
    capabilities: number.capabilities,
    date_created: twilioDate(number.created_at),
    date_updated: twilioDate(number.updated_at),
    uri: `/${API_VERSION}/Accounts/${number.account_sid}/IncomingPhoneNumbers/${number.sid}.json`,
  };
}

export function formatMessagingService(service: TwilioMessagingService): Record<string, unknown> {
  return {
    sid: service.sid,
    account_sid: service.account_sid,
    friendly_name: service.friendly_name,
    inbound_request_url: service.inbound_request_url,
    status_callback: service.status_callback,
    date_created: service.created_at,
    date_updated: service.updated_at,
    url: `https://messaging.twilio.com/v1/Services/${service.sid}`,
    links: {
      phone_numbers: `https://messaging.twilio.com/v1/Services/${service.sid}/PhoneNumbers`,
    },
  };
}

export function formatMessagingServicePhoneNumber(
  item: TwilioMessagingServicePhoneNumber,
  phoneNumber: TwilioIncomingPhoneNumber | undefined,
): Record<string, unknown> {
  return {
    sid: item.sid,
    account_sid: item.account_sid,
    service_sid: item.service_sid,
    phone_number_sid: item.phone_number_sid,
    phone_number: phoneNumber?.phone_number ?? null,
    date_created: item.created_at,
    date_updated: item.updated_at,
    url: `https://messaging.twilio.com/v1/Services/${item.service_sid}/PhoneNumbers/${item.sid}`,
  };
}

export function formatMessage(message: TwilioMessage): Record<string, unknown> {
  return {
    sid: message.sid,
    date_created: twilioDate(message.created_at),
    date_updated: twilioDate(message.updated_at),
    date_sent: twilioDate(message.date_sent),
    account_sid: message.account_sid,
    to: message.to,
    from: message.from,
    messaging_service_sid: message.messaging_service_sid,
    body: message.body,
    status: message.status,
    num_segments: message.num_segments,
    num_media: message.num_media,
    direction: message.direction,
    api_version: message.api_version,
    price: message.price,
    price_unit: message.price_unit,
    error_code: message.error_code,
    error_message: message.error_message,
    uri: `/${API_VERSION}/Accounts/${message.account_sid}/Messages/${message.sid}.json`,
    subresource_uris: {
      media: `/${API_VERSION}/Accounts/${message.account_sid}/Messages/${message.sid}/Media.json`,
      feedback: `/${API_VERSION}/Accounts/${message.account_sid}/Messages/${message.sid}/Feedback.json`,
    },
  };
}

export function formatMedia(media: TwilioMedia): Record<string, unknown> {
  return {
    sid: media.sid,
    account_sid: media.account_sid,
    parent_sid: media.message_sid,
    content_type: media.content_type,
    date_created: twilioDate(media.created_at),
    date_updated: twilioDate(media.updated_at),
    uri: media.uri,
  };
}

export function formatVerifyService(service: TwilioVerifyService): Record<string, unknown> {
  return {
    sid: service.sid,
    account_sid: service.account_sid,
    friendly_name: service.friendly_name,
    code_length: service.code.length,
    default_template_sid: null,
    date_created: service.created_at,
    date_updated: service.updated_at,
    url: `https://verify.twilio.com/v2/Services/${service.sid}`,
    links: {
      verifications: `https://verify.twilio.com/v2/Services/${service.sid}/Verifications`,
      verification_checks: `https://verify.twilio.com/v2/Services/${service.sid}/VerificationCheck`,
    },
  };
}

export function formatVerification(verification: TwilioVerification): Record<string, unknown> {
  return {
    sid: verification.sid,
    service_sid: verification.service_sid,
    account_sid: verification.account_sid,
    to: verification.to,
    channel: verification.channel,
    status: verification.status,
    valid: verification.valid,
    lookup: verification.lookup,
    amount: null,
    payee: null,
    send_code_attempts: verification.send_code_attempts,
    date_created: verification.created_at,
    date_updated: verification.updated_at,
    url: `https://verify.twilio.com/v2/Services/${verification.service_sid}/Verifications/${verification.sid}`,
  };
}

export function formatVerificationCheck(verification: TwilioVerification): Record<string, unknown> {
  return {
    sid: verification.sid,
    service_sid: verification.service_sid,
    account_sid: verification.account_sid,
    to: verification.to,
    channel: verification.channel,
    status: verification.status,
    valid: verification.valid,
    date_created: verification.created_at,
    date_updated: verification.updated_at,
  };
}

export function formatCall(call: TwilioCall): Record<string, unknown> {
  return {
    sid: call.sid,
    parent_call_sid: call.parent_call_sid,
    date_created: twilioDate(call.created_at),
    date_updated: twilioDate(call.updated_at),
    account_sid: call.account_sid,
    to: call.to,
    from: call.from,
    phone_number_sid: call.phone_number_sid,
    status: call.status,
    start_time: twilioDate(call.start_time),
    end_time: twilioDate(call.end_time),
    duration: call.duration,
    price: call.price,
    price_unit: call.price_unit,
    direction: call.direction,
    answered_by: null,
    api_version: call.api_version,
    annotation: null,
    forwarded_from: null,
    group_sid: null,
    caller_name: null,
    queue_time: "0",
    trunk_sid: null,
    uri: `/${API_VERSION}/Accounts/${call.account_sid}/Calls/${call.sid}.json`,
    subresource_uris: {
      notifications: `/${API_VERSION}/Accounts/${call.account_sid}/Calls/${call.sid}/Notifications.json`,
      recordings: `/${API_VERSION}/Accounts/${call.account_sid}/Calls/${call.sid}/Recordings.json`,
    },
  };
}

export function formatConversationService(service: TwilioConversationService): Record<string, unknown> {
  return {
    sid: service.sid,
    account_sid: service.account_sid,
    friendly_name: service.friendly_name,
    date_created: service.created_at,
    date_updated: service.updated_at,
    url: `https://conversations.twilio.com/v1/Services/${service.sid}`,
    links: {
      conversations: `https://conversations.twilio.com/v1/Services/${service.sid}/Conversations`,
      users: `https://conversations.twilio.com/v1/Services/${service.sid}/Users`,
    },
  };
}

export function formatConversation(conversation: TwilioConversation): Record<string, unknown> {
  return {
    sid: conversation.sid,
    account_sid: conversation.account_sid,
    chat_service_sid: conversation.service_sid,
    messaging_service_sid: null,
    friendly_name: conversation.friendly_name,
    unique_name: conversation.unique_name,
    attributes: conversation.attributes,
    state: conversation.state,
    date_created: conversation.created_at,
    date_updated: conversation.updated_at,
    url: `https://conversations.twilio.com/v1/Services/${conversation.service_sid}/Conversations/${conversation.sid}`,
    links: {
      participants: `https://conversations.twilio.com/v1/Services/${conversation.service_sid}/Conversations/${conversation.sid}/Participants`,
      messages: `https://conversations.twilio.com/v1/Services/${conversation.service_sid}/Conversations/${conversation.sid}/Messages`,
    },
  };
}

export function formatConversationParticipant(participant: TwilioConversationParticipant): Record<string, unknown> {
  return {
    sid: participant.sid,
    account_sid: participant.account_sid,
    chat_service_sid: participant.service_sid,
    conversation_sid: participant.conversation_sid,
    identity: participant.identity,
    attributes: participant.attributes,
    messaging_binding: {
      address: participant.messaging_binding_address,
      proxy_address: participant.messaging_binding_proxy_address,
    },
    date_created: participant.created_at,
    date_updated: participant.updated_at,
    url: `https://conversations.twilio.com/v1/Services/${participant.service_sid}/Conversations/${participant.conversation_sid}/Participants/${participant.sid}`,
  };
}

export function formatConversationMessage(message: TwilioConversationMessage): Record<string, unknown> {
  return {
    sid: message.sid,
    account_sid: message.account_sid,
    chat_service_sid: message.service_sid,
    conversation_sid: message.conversation_sid,
    author: message.author,
    body: message.body,
    index: message.index,
    attributes: message.attributes,
    date_created: message.created_at,
    date_updated: message.updated_at,
    url: `https://conversations.twilio.com/v1/Services/${message.service_sid}/Conversations/${message.conversation_sid}/Messages/${message.sid}`,
  };
}

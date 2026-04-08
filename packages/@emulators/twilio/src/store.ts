import { Store, type Collection } from "@emulators/core";
import type {
  TwilioMessage,
  TwilioCall,
  TwilioVerifyService,
  TwilioVerification,
  TwilioPhoneNumber,
} from "./entities.js";

export interface TwilioStore {
  messages: Collection<TwilioMessage>;
  calls: Collection<TwilioCall>;
  verifyServices: Collection<TwilioVerifyService>;
  verifications: Collection<TwilioVerification>;
  phoneNumbers: Collection<TwilioPhoneNumber>;
}

export function getTwilioStore(store: Store): TwilioStore {
  return {
    messages: store.collection<TwilioMessage>("twilio.messages", ["sid", "account_sid"]),
    calls: store.collection<TwilioCall>("twilio.calls", ["sid", "account_sid"]),
    verifyServices: store.collection<TwilioVerifyService>("twilio.verify_services", ["sid"]),
    verifications: store.collection<TwilioVerification>("twilio.verifications", ["sid", "service_sid"]),
    phoneNumbers: store.collection<TwilioPhoneNumber>("twilio.phone_numbers", ["sid", "phone_number"]),
  };
}

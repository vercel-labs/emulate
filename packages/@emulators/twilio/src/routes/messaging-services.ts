import type { Context, RouteContext } from "@emulators/core";
import { twilioSid } from "../ids.js";
import { formatMessagingService, formatMessagingServicePhoneNumber } from "../formatters.js";
import { getTwilioStore } from "../store.js";
import {
  bodyString,
  normalizePhoneNumber,
  parseTwilioBody,
  requireTwilioAuth,
  twilioError,
  twilioList,
} from "../helpers.js";

export function messagingServiceRoutes({ app, store }: RouteContext): void {
  const ts = getTwilioStore(store);

  app.get("/messaging/v1/Services", (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const services = ts.messagingServices.findBy("account_sid", account.sid);
    return twilioList(c, "services", services, "/v1/Services", formatMessagingService);
  });

  app.post("/messaging/v1/Services", async (c) => {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const friendlyName = bodyString(body, "FriendlyName");
    if (!friendlyName) return twilioError(c, 400, "FriendlyName is required", 20001);
    const service = ts.messagingServices.insert({
      sid: twilioSid("MG"),
      account_sid: account.sid,
      friendly_name: friendlyName,
      inbound_request_url: bodyString(body, "InboundRequestUrl") ?? null,
      status_callback: bodyString(body, "StatusCallback") ?? null,
    });
    return c.json(formatMessagingService(service), 201);
  });

  app.get("/messaging/v1/Services/:serviceSid", (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    return c.json(formatMessagingService(service));
  });

  app.post("/messaging/v1/Services/:serviceSid", async (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const body = await parseTwilioBody(c);
    const updated = ts.messagingServices.update(service.id, {
      friendly_name: bodyString(body, "FriendlyName") ?? service.friendly_name,
      inbound_request_url: bodyString(body, "InboundRequestUrl") ?? service.inbound_request_url,
      status_callback: bodyString(body, "StatusCallback") ?? service.status_callback,
    })!;
    return c.json(formatMessagingService(updated));
  });

  app.delete("/messaging/v1/Services/:serviceSid", (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    for (const assignment of ts.messagingServicePhoneNumbers.findBy("service_sid", service.sid)) {
      ts.messagingServicePhoneNumbers.delete(assignment.id);
    }
    ts.messagingServices.delete(service.id);
    return c.body(null, 204);
  });

  app.get("/messaging/v1/Services/:serviceSid/PhoneNumbers", (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const assignments = ts.messagingServicePhoneNumbers.findBy("service_sid", service.sid);
    return twilioList(c, "phone_numbers", assignments, `/v1/Services/${service.sid}/PhoneNumbers`, (assignment) =>
      formatMessagingServicePhoneNumber(assignment, ts.phoneNumbers.findOneBy("sid", assignment.phone_number_sid)),
    );
  });

  app.post("/messaging/v1/Services/:serviceSid/PhoneNumbers", async (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const body = await parseTwilioBody(c);
    const phoneNumberSid = bodyString(body, "PhoneNumberSid");
    const phoneNumberValue = normalizePhoneNumber(bodyString(body, "PhoneNumber"));
    const phoneNumber = phoneNumberSid
      ? ts.phoneNumbers.findOneBy("sid", phoneNumberSid)
      : phoneNumberValue
        ? ts.phoneNumbers.findOneBy("phone_number", phoneNumberValue)
        : undefined;
    if (!phoneNumber || phoneNumber.account_sid !== service.account_sid) {
      return twilioError(c, 404, "Phone number was not found", 20404);
    }
    const existing = ts.messagingServicePhoneNumbers
      .findBy("service_sid", service.sid)
      .find((assignment) => assignment.phone_number_sid === phoneNumber.sid);
    if (existing) return c.json(formatMessagingServicePhoneNumber(existing, phoneNumber), 200);
    const assignment = ts.messagingServicePhoneNumbers.insert({
      sid: twilioSid("PN"),
      account_sid: service.account_sid,
      service_sid: service.sid,
      phone_number_sid: phoneNumber.sid,
    });
    return c.json(formatMessagingServicePhoneNumber(assignment, phoneNumber), 201);
  });

  app.delete("/messaging/v1/Services/:serviceSid/PhoneNumbers/:sid", (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const assignment = ts.messagingServicePhoneNumbers.findOneBy("sid", c.req.param("sid"));
    if (!assignment || assignment.service_sid !== service.sid) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    ts.messagingServicePhoneNumbers.delete(assignment.id);
    return c.body(null, 204);
  });

  function authenticatedAccount(c: Context) {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    return auth;
  }

  function authenticatedService(c: Context) {
    const account = authenticatedAccount(c);
    if (account instanceof Response) return account;
    const service = ts.messagingServices.findOneBy("sid", c.req.param("serviceSid"));
    if (!service || service.account_sid !== account.sid) {
      return twilioError(c, 404, "The requested resource was not found", 20404);
    }
    return service;
  }
}

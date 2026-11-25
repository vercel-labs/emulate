import type { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";

export interface Appointment {
  id: number;
  service: string;
  startsAt: string;
  /** Expo push tokens of every device the customer signed in on. */
  pushTokens: string[];
}

export interface ReminderResult {
  /** Tokens the service says it will never reach again. Delete these from your database. */
  deadTokens: string[];
  sent: number;
}

/**
 * Sends one reminder per appointment, then checks the receipts and reports the tokens
 * that Expo says are no longer registered.
 */
export async function sendReminders(expo: Expo, appointments: Appointment[]): Promise<ReminderResult> {
  const messages: ExpoPushMessage[] = [];
  for (const appointment of appointments) {
    for (const to of appointment.pushTokens) {
      messages.push({
        to,
        title: "Appointment reminder",
        body: `${appointment.service} at ${appointment.startsAt}`,
        data: { appointmentId: appointment.id },
        sound: "default",
      });
    }
  }

  const dead = new Set<string>();
  const receiptIds: string[] = [];
  const tokenByReceipt = new Map<string, string>();

  for (const chunk of expo.chunkPushNotifications(messages)) {
    const tickets: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);
    tickets.forEach((ticket, index) => {
      const to = chunk[index].to as string;
      if (ticket.status === "ok") {
        receiptIds.push(ticket.id);
        tokenByReceipt.set(ticket.id, to);
      } else if (ticket.details?.error === "DeviceNotRegistered") {
        dead.add(to);
      }
    });
  }

  for (const ids of expo.chunkPushNotificationReceiptIds(receiptIds)) {
    const receipts = await expo.getPushNotificationReceiptsAsync(ids);
    for (const [id, receipt] of Object.entries(receipts)) {
      if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
        dead.add(tokenByReceipt.get(id) as string);
      }
    }
  }

  return { deadTokens: [...dead], sent: messages.length };
}

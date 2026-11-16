/** Gives the Resend flow a cookie secret for this server run when AUTH_SECRET is not set. */
export function register() {
  process.env.AUTH_SECRET ??= Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

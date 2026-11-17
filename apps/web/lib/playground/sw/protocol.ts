/** The path the playground service worker answers under: each emulator lives at `<mount>/<service>`. */
export const EMULATOR_MOUNT = "/playground/emulate";

/** The reserved first segment for resetting an emulator: POST `<mount>/_reset/<service>`. */
export const RESET_SEGMENT = "_reset";

/** A request with this header gets a redirect back as a 200 that names the real status and Location in headers. */
export const RAW_REDIRECT_HEADER = "X-Emulate-Raw-Redirect";

/** A page posts this message to make an already active worker take control of it, which a hard reload skips. */
export const CLAIM_MESSAGE = "emulate-playground-claim";

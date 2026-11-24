/** Base URL this app is served from. The playground runs locally only, and the port comes from PORT. */
export const origin = `http://localhost:${process.env.PORT ?? "3000"}`;

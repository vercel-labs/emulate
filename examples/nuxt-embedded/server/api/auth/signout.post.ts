export default defineEventHandler((event) => {
  endSession(event);
  return sendRedirect(event, "/");
});

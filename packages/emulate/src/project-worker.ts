import { prepareProject, type ProjectOptions, type RetainedSeed } from "./project-runner.js";

let run: Awaited<ReturnType<typeof prepareProject>> | undefined;
let preparing: ReturnType<typeof prepareProject> | undefined;
const controller = new AbortController();
let closing: Promise<void> | undefined;
function close() {
  return (closing ??= (async () => {
    controller.abort(new Error("Emulator startup stopped"));
    await preparing?.catch((error) => {
      if (error instanceof AggregateError) throw error;
    });
    await run?.close();
  })());
}
let handling = Promise.resolve();
process.on(
  "message",
  (message: { type: string; options?: ProjectOptions; retained?: Record<string, RetainedSeed>; reload?: boolean }) => {
    if (message.type === "close") {
      void close().then(
        () => {
          if (process.connected) {
            process.send?.({ type: "closed" }, () => {
              if (process.connected) process.disconnect();
            });
          }
        },
        (error) => {
          if (process.connected)
            process.send?.({ type: "error", error: error instanceof Error ? error.stack : String(error) });
        },
      );
      return;
    }
    handling = handling.then(async () => {
      try {
        controller.signal.throwIfAborted();
        if (message.type === "prepare") {
          run = await (preparing = prepareProject(
            message.options!,
            message.retained,
            message.reload,
            (dependencies) => {
              if (process.connected) process.send?.({ type: "dependencies", dependencies }, () => {});
            },
            controller.signal,
          ));
          process.send?.({ type: "prepared", metadata: run.metadata });
        } else if (message.type === "start") {
          run!.watchDependencies((dependencies) => {
            if (process.connected) process.send?.({ type: "dependencies", dependencies }, () => {});
          });
          await run!.start();
          process.send?.({ type: "started" });
        }
      } catch (error) {
        if (process.connected && !controller.signal.aborted)
          process.send?.({ type: "error", error: error instanceof Error ? error.stack : String(error) });
      }
    });
  },
);
process.on("disconnect", () => {
  const timer = setTimeout(() => process.exit(1), 7000);
  void close()
    .catch(console.error)
    .finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
});

import type { RouteContext } from "@emulators/core";
import { getAsanaStore } from "../store.js";
import { asanaError, asanaData, parseAsanaBody, formatStory } from "../helpers.js";

export function storyRoutes({ app, store }: RouteContext): void {
  const as = () => getAsanaStore(store);

  app.get("/api/1.0/stories/:story_gid", (c) => {
    const gid = c.req.param("story_gid");
    const story = as().stories.findOneBy("gid", gid);
    if (!story) return asanaError(c, 404, "story: Not Found");
    return c.json(asanaData(formatStory(story, as())));
  });

  app.put("/api/1.0/stories/:story_gid", async (c) => {
    const gid = c.req.param("story_gid");
    const story = as().stories.findOneBy("gid", gid);
    if (!story) return asanaError(c, 404, "story: Not Found");
    if (!story.is_editable) return asanaError(c, 403, "story: Not editable");

    const body = await parseAsanaBody(c);
    const updates: Partial<{ text: string; html_text: string }> = {};
    if (body.text !== undefined) updates.text = body.text as string;
    if (body.html_text !== undefined) updates.html_text = body.html_text as string;

    const updated = as().stories.update(story.id, updates);
    return c.json(asanaData(formatStory(updated ?? story, as())));
  });

  app.delete("/api/1.0/stories/:story_gid", (c) => {
    const gid = c.req.param("story_gid");
    const story = as().stories.findOneBy("gid", gid);
    if (!story) return asanaError(c, 404, "story: Not Found");

    as().stories.delete(story.id);
    return c.json(asanaData({}));
  });
}

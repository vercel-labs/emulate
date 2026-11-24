import type { ConsoleService, ConsoleVariable } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };
const MESSAGES_HEADERS = { ...JSON_HEADERS, "anthropic-version": "2023-06-01" };
const BOUNDARY = "emulate-playground";
const FORM_HEADERS = { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` };
const WEATHER_PARAMETERS = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};
const IMAGE_EDIT_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#0070f3"/></svg>';
const VERTEX_VEO = "/v1/projects/my-project/locations/us-central1/publishers/google/models/veo-3.0-generate-001";

function json(body: unknown): string {
  return JSON.stringify(body, null, 2);
}

/** A multipart/form-data body written as text, so its files can only hold text such as an SVG or a stand-in recording. */
function multipart(parts: { name: string; value: string; filename?: string; type?: string }[]): string {
  return [
    ...parts.map((part) =>
      [
        `--${BOUNDARY}`,
        `Content-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}`,
        ...(part.type ? [`Content-Type: ${part.type}`] : []),
        "",
        part.value,
      ].join("\r\n"),
    ),
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

const variables: ConsoleVariable[] = [
  {
    name: "response_id",
    label: "Response id",
    hint: "Filled in when you run Create a response. A stored response can be continued, read, and deleted.",
  },
  {
    name: "video_id",
    label: "Video id",
    hint: "Filled in when you run Create an OpenAI video job. Each status read advances the job one step until it completes.",
  },
  {
    name: "xai_request_id",
    label: "xAI request id",
    hint: "Filled in when you run Generate an xAI video. Each status read advances the job one step until it is done.",
  },
  {
    name: "veo_operation",
    label: "Veo operation",
    hint: "Filled in when you run Start a Veo operation. Each read advances the operation one step until it is done.",
  },
  {
    name: "vertex_operation",
    label: "Vertex operation",
    hint: "Filled in when you run Start a Vertex Veo operation. Each read advances the operation one step until it is done.",
  },
];

/** AI requests for the request console: every wire format and modality the emulator answers, plus its control routes. */
export const ai: ConsoleService = {
  name: "ai",
  label: "AI",
  description:
    "OpenAI, Anthropic, Gemini, xAI, ElevenLabs, and AI Gateway requests for text, images, audio, video, and decisions, answered by rules instead of a model.",
  variables,
  groups: [
    {
      title: "Chat Completions",
      presets: [
        {
          label: "Echo a message",
          description: "No rule matches this text, so the default reply repeats the latest user message.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", messages: [{ role: "user", content: "Say this back to me" }] }),
        },
        {
          label: "Match a rule",
          description: "The seeded greeting rule answers any message that contains hello.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", messages: [{ role: "user", content: "hello there" }] }),
        },
        {
          label: "Stream a reply",
          description: "Returns the reply as server-sent events, ending with [DONE].",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hello there" }] }),
        },
        {
          label: "Ask for structured output",
          description: "No rule is needed: the default reply is generated to fit the JSON Schema.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({
            model: "gpt-4o",
            messages: [{ role: "user", content: "Describe a city" }],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "city",
                schema: {
                  type: "object",
                  properties: { name: { type: "string" }, population: { type: "integer" } },
                  required: ["name", "population"],
                  additionalProperties: false,
                },
              },
            },
          }),
        },
        {
          label: "Call a tool",
          description: "The seeded weather rule answers a request that declares get_weather with a tool call.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({
            model: "gpt-4o",
            messages: [{ role: "user", content: "What is the weather in Paris?" }],
            tools: [{ type: "function", function: { name: "get_weather", parameters: WEATHER_PARAMETERS } }],
          }),
        },
      ],
    },
    {
      title: "Responses",
      presets: [
        {
          label: "Create a response",
          description: "Stores the response and keeps its id, so the next requests can use it.",
          method: "POST",
          path: "/v1/responses",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", input: "hello there" }),
          captures: { response_id: "id" },
        },
        {
          label: "Continue the conversation",
          description: "Sends a new turn on top of the stored response. Run Create a response first.",
          method: "POST",
          path: "/v1/responses",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-4o", input: "Say this back to me", previous_response_id: "{{response_id}}" }),
        },
        {
          label: "Get a stored response",
          description: "Reads the stored response back. Run Create a response first.",
          method: "GET",
          path: "/v1/responses/{{response_id}}",
        },
        {
          label: "Delete a stored response",
          description: "Removes the stored response. Run Create a response first.",
          method: "DELETE",
          path: "/v1/responses/{{response_id}}",
        },
      ],
    },
    {
      title: "Messages",
      presets: [
        {
          label: "Send a message",
          description: "The Anthropic wire format: max_tokens is required and the reply is a list of content blocks.",
          method: "POST",
          path: "/v1/messages",
          headers: MESSAGES_HEADERS,
          body: json({
            model: "claude-sonnet-4-5",
            max_tokens: 256,
            messages: [{ role: "user", content: "hello there" }],
          }),
        },
        {
          label: "Stop at a stop sequence",
          description: "The reply is cut at the first stop sequence and reports stop_reason stop_sequence.",
          method: "POST",
          path: "/v1/messages",
          headers: MESSAGES_HEADERS,
          body: json({
            model: "claude-sonnet-4-5",
            max_tokens: 256,
            stop_sequences: ["back"],
            messages: [{ role: "user", content: "Say this back to me" }],
          }),
        },
        {
          label: "Stream a message",
          description: "Returns the reply as Anthropic's server-sent events, from message_start to message_stop.",
          method: "POST",
          path: "/v1/messages",
          headers: MESSAGES_HEADERS,
          body: json({
            model: "claude-sonnet-4-5",
            max_tokens: 256,
            stream: true,
            messages: [{ role: "user", content: "hello there" }],
          }),
        },
      ],
    },
    {
      title: "Gemini",
      presets: [
        {
          label: "Generate content",
          description: "The seeded greeting rule answers in the Gemini format, as a text part of the first candidate.",
          method: "POST",
          path: "/v1beta/models/gemini-3-flash:generateContent",
          headers: JSON_HEADERS,
          body: json({ contents: [{ role: "user", parts: [{ text: "hello there" }] }] }),
        },
        {
          label: "Stream content",
          description:
            "With alt=sse the reply arrives as server-sent events of partial responses. The last one reports finishReason STOP.",
          method: "POST",
          path: "/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse",
          headers: JSON_HEADERS,
          body: json({ contents: [{ role: "user", parts: [{ text: "hello there" }] }] }),
        },
        {
          label: "Call a function",
          description:
            "The seeded weather rule answers a request that declares get_weather with a functionCall part and a thought signature.",
          method: "POST",
          path: "/v1beta/models/gemini-3-flash:generateContent",
          headers: JSON_HEADERS,
          body: json({
            contents: [{ role: "user", parts: [{ text: "What is the weather in Paris?" }] }],
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "get_weather",
                    parameters: { type: "OBJECT", properties: { city: { type: "STRING" } }, required: ["city"] },
                  },
                ],
              },
            ],
          }),
        },
        {
          label: "Ask for structured output",
          description:
            "A JSON response type with a response schema returns a text part holding JSON that fits the schema.",
          method: "POST",
          path: "/v1beta/models/gemini-3-flash:generateContent",
          headers: JSON_HEADERS,
          body: json({
            contents: [{ role: "user", parts: [{ text: "Describe a city" }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: { name: { type: "STRING" }, population: { type: "INTEGER" } },
                required: ["name", "population"],
              },
            },
          }),
        },
        {
          label: "Generate an image",
          description: "Asking for the TEXT and IMAGE modalities returns a 1024x576 PNG as base64 inlineData.",
          method: "POST",
          path: "/v1beta/models/gemini-3-flash-image:generateContent",
          headers: JSON_HEADERS,
          body: json({
            contents: [{ role: "user", parts: [{ text: "A fox in the snow" }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } },
          }),
        },
        {
          label: "Generate speech",
          description: "Asking for the AUDIO modality returns 24 kHz 16-bit PCM speech as base64 inlineData.",
          method: "POST",
          path: "/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
          headers: JSON_HEADERS,
          body: json({
            contents: [{ role: "user", parts: [{ text: "Hello there." }] }],
            generationConfig: { responseModalities: ["AUDIO"] },
          }),
        },
      ],
    },
    {
      title: "AI Gateway",
      presets: [
        {
          label: "Generate text through the gateway",
          description:
            "The protocol the AI SDK gateway provider speaks. The model id goes in a header and the reply is a list of AI SDK content parts.",
          method: "POST",
          path: "/v4/ai/language-model",
          headers: { ...JSON_HEADERS, "ai-language-model-id": "openai/gpt-5.5" },
          body: json({ prompt: [{ role: "user", content: [{ type: "text", text: "hello there" }] }] }),
        },
        {
          label: "Stream text through the gateway",
          description:
            "The streaming header turns the reply into server-sent events of AI SDK stream parts, from stream-start to finish.",
          method: "POST",
          path: "/v4/ai/language-model",
          headers: { ...JSON_HEADERS, "ai-language-model-id": "openai/gpt-5.5", "ai-language-model-streaming": "true" },
          body: json({ prompt: [{ role: "user", content: [{ type: "text", text: "hello there" }] }] }),
        },
        {
          label: "Call a tool through the gateway",
          description:
            "The seeded weather rule answers a request that declares get_weather with a tool-call content part.",
          method: "POST",
          path: "/v4/ai/language-model",
          headers: { ...JSON_HEADERS, "ai-language-model-id": "openai/gpt-5.5" },
          body: json({
            prompt: [{ role: "user", content: [{ type: "text", text: "What is the weather in Paris?" }] }],
            tools: [{ type: "function", name: "get_weather", inputSchema: WEATHER_PARAMETERS }],
          }),
        },
        {
          label: "Generate an image through the gateway",
          description: "The image model endpoint returns a list of base64 PNG images at the requested aspect ratio.",
          method: "POST",
          path: "/v4/ai/image-model",
          headers: { ...JSON_HEADERS, "ai-model-id": "bfl/flux-2-pro" },
          body: json({ prompt: "A red panda", n: 1, aspectRatio: "16:9" }),
        },
        {
          label: "Generate speech through the gateway",
          description: "The speech model endpoint returns the spoken text as base64 WAV audio.",
          method: "POST",
          path: "/v4/ai/speech-model",
          headers: { ...JSON_HEADERS, "ai-model-id": "openai/tts-1" },
          body: json({ text: "Hello there.", outputFormat: "wav" }),
        },
        {
          label: "Generate a video through the gateway",
          description:
            "The video model endpoint answers with one server-sent event holding a base64 MP4 of the requested size and length.",
          method: "POST",
          path: "/v4/ai/video-model",
          headers: { ...JSON_HEADERS, "ai-model-id": "google/veo-3.1-generate-001" },
          body: json({ prompt: "A cat on a windowsill", n: 1, duration: 1, resolution: "320x180" }),
        },
        {
          label: "Answer decisions through the gateway",
          description:
            "The decision model endpoint answers each question about the state with a probability, a choice, or a score.",
          method: "POST",
          path: "/v4/ai/decision-model",
          headers: { ...JSON_HEADERS, "ai-model-id": "typesafe-ai/jev" },
          body: json({
            stateParts: [{ type: "text", text: "My package arrived crushed." }],
            questions: {
              damaged: { type: "boolean", instructions: "Is the package damaged?" },
              queue: { type: "choice", criteria: { billing: null, shipping: null } },
              urgency: { type: "score", criteria: ["low", "medium", "high"] },
            },
          }),
        },
      ],
    },
    {
      title: "Images",
      presets: [
        {
          label: "Generate images",
          description:
            "No rule matches, so each image is a solid color derived from the prompt. Returns two 256x256 PNGs as base64 in data.",
          method: "POST",
          path: "/v1/images/generations",
          headers: JSON_HEADERS,
          body: json({ model: "gpt-image-2", prompt: "a fox in the snow", n: 2, size: "256x256" }),
        },
        {
          label: "Stream partial images",
          description:
            "Returns server-sent events: one image_generation.partial_image event, then image_generation.completed with usage.",
          method: "POST",
          path: "/v1/images/generations",
          headers: JSON_HEADERS,
          body: json({
            model: "gpt-image-2",
            prompt: "a fox in the snow",
            size: "256x256",
            stream: true,
            partial_images: 1,
          }),
        },
        {
          label: "Edit an uploaded image",
          description:
            "Uploads a small SVG as multipart form data and returns the edited image as a transparent 256x256 WebP.",
          method: "POST",
          path: "/v1/images/edits",
          headers: FORM_HEADERS,
          body: multipart([
            { name: "model", value: "gpt-image-2" },
            { name: "prompt", value: "Add a red circle in the middle" },
            { name: "size", value: "256x256" },
            { name: "background", value: "transparent" },
            { name: "output_format", value: "webp" },
            { name: "image[]", value: IMAGE_EDIT_SOURCE, filename: "square.svg", type: "image/svg+xml" },
          ]),
        },
        {
          label: "Generate with an xAI aspect ratio",
          description:
            "The xAI request shape: aspect_ratio replaces size, so 16:9 returns a 1024x576 image, here as a data URL.",
          method: "POST",
          path: "/v1/images/generations",
          headers: JSON_HEADERS,
          body: json({
            model: "grok-imagine-image",
            prompt: "a fox in the snow",
            aspect_ratio: "16:9",
            response_format: "url",
          }),
        },
        {
          label: "Edit an image by URL with xAI",
          description:
            "The xAI edit shape names its source as an image object with a URL. The URL is recorded, not downloaded, and a 1024x1024 PNG comes back.",
          method: "POST",
          path: "/v1/images/edits",
          headers: JSON_HEADERS,
          body: json({
            model: "grok-imagine-image",
            prompt: "Render this as a pencil sketch",
            image: { url: "https://example.com/photo.png", type: "image_url" },
          }),
        },
        {
          label: "Generate an image in a chat reply",
          description:
            "A Chat Completions request with modalities text and image, as AI Gateway and OpenRouter send it. The reply carries a 512x288 PNG data URL in message.images.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({
            model: "google/gemini-3.1-flash-image-preview",
            modalities: ["text", "image"],
            image_config: { image_size: "512", aspect_ratio: "16:9" },
            messages: [{ role: "user", content: "Draw a fox in the snow" }],
          }),
        },
      ],
    },
    {
      title: "Audio",
      presets: [
        {
          label: "Speak text",
          description:
            "OpenAI text to speech. Returns an MP3 of silence that lasts as long as the input takes to read aloud.",
          method: "POST",
          path: "/v1/audio/speech",
          headers: JSON_HEADERS,
          body: json({
            model: "gpt-4o-mini-tts",
            voice: "alloy",
            input: "Hello from the emulator",
            response_format: "mp3",
          }),
        },
        {
          label: "Transcribe a recording",
          description:
            "Uploads a small file as multipart form data. Returns a deterministic transcript naming the file, with word and segment timings.",
          method: "POST",
          path: "/v1/audio/transcriptions",
          headers: FORM_HEADERS,
          body: multipart([
            { name: "model", value: "whisper-1" },
            { name: "response_format", value: "verbose_json" },
            { name: "timestamp_granularities[]", value: "word" },
            { name: "file", value: "placeholder audio", filename: "meeting.wav", type: "audio/wav" },
          ]),
        },
        {
          label: "Translate to English subtitles",
          description:
            "Uploads a small file to the translation endpoint and asks for SubRip subtitles, returned as plain text.",
          method: "POST",
          path: "/v1/audio/translations",
          headers: FORM_HEADERS,
          body: multipart([
            { name: "model", value: "whisper-1" },
            { name: "response_format", value: "srt" },
            { name: "file", value: "placeholder audio", filename: "interview.wav", type: "audio/wav" },
          ]),
        },
        {
          label: "Speak a chat reply",
          description:
            "Chat Completions with audio output. The message carries base64 FLAC audio and its transcript instead of text content.",
          method: "POST",
          path: "/v1/chat/completions",
          headers: JSON_HEADERS,
          body: json({
            model: "gpt-audio-1.5",
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "flac" },
            messages: [{ role: "user", content: "Say hello" }],
          }),
        },
        {
          label: "ElevenLabs text to speech",
          description:
            "Speaks with any voice id in the path. The output_format query picks the codec and sample rate, here MP3.",
          method: "POST",
          path: "/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_22050_32",
          headers: JSON_HEADERS,
          body: json({ text: "Hello from the emulator", model_id: "eleven_multilingual_v2" }),
        },
        {
          label: "ElevenLabs speech to text",
          description:
            "Uploads a small file as multipart form data. Returns the transcript with timed words, each tagged with a speaker.",
          method: "POST",
          path: "/v1/speech-to-text",
          headers: FORM_HEADERS,
          body: multipart([
            { name: "model_id", value: "scribe_v2" },
            { name: "diarize", value: "true" },
            { name: "file", value: "placeholder audio", filename: "call.wav", type: "audio/wav" },
          ]),
        },
      ],
    },
    {
      title: "Video",
      presets: [
        {
          label: "Create an OpenAI video job",
          description: "Starts a four second Sora job and keeps its id. The job comes back queued with progress 0.",
          method: "POST",
          path: "/v1/videos",
          headers: JSON_HEADERS,
          body: json({ model: "sora-2", prompt: "A paper boat drifting on a pond", seconds: "4", size: "720x1280" }),
          captures: { video_id: "id" },
        },
        {
          label: "Check the OpenAI video job",
          description:
            "Each status read advances the job one step: the first reports in_progress, the second completed. Run Create an OpenAI video job first.",
          method: "GET",
          path: "/v1/videos/{{video_id}}",
        },
        {
          label: "Download the OpenAI video",
          description:
            "Returns the finished video as an MP4. Run Check the OpenAI video job until it reports completed first.",
          method: "GET",
          path: "/v1/videos/{{video_id}}/content",
        },
        {
          label: "Generate an xAI video",
          description: "Starts a one second Grok Imagine job and keeps its request_id, which is all the reply holds.",
          method: "POST",
          path: "/v1/videos/generations",
          headers: JSON_HEADERS,
          body: json({
            model: "grok-imagine-video",
            prompt: "A paper boat drifting on a pond",
            duration: 1,
            aspect_ratio: "1:1",
            resolution: "480p",
          }),
          captures: { xai_request_id: "request_id" },
        },
        {
          label: "Check the xAI video",
          description:
            "Each status read advances the job one step: the first reports pending, the second done with the video URL. Run Generate an xAI video first.",
          method: "GET",
          path: "/v1/videos/{{xai_request_id}}",
        },
        {
          label: "Start a Veo operation",
          description:
            "Starts a Veo long-running operation on the Gemini API and keeps its name. The reply holds only the operation name.",
          method: "POST",
          path: "/v1beta/models/veo-3.0-generate-001:predictLongRunning",
          headers: JSON_HEADERS,
          body: json({
            instances: [{ prompt: "A paper boat drifting on a pond" }],
            parameters: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 4 },
          }),
          captures: { veo_operation: "name" },
        },
        {
          label: "Get the Veo operation",
          description:
            "Each read advances the operation one step: the first returns only its name, the second done with a download uri per sample. Run Start a Veo operation first.",
          method: "GET",
          path: "/v1beta/{{veo_operation}}",
        },
        {
          label: "Start a Vertex Veo operation",
          description: "Starts a Veo operation under a Vertex AI project path and keeps its full operation name.",
          method: "POST",
          path: `${VERTEX_VEO}:predictLongRunning`,
          headers: JSON_HEADERS,
          body: json({
            instances: [{ prompt: "A paper boat drifting on a pond" }],
            parameters: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 4, sampleCount: 1 },
          }),
          captures: { vertex_operation: "name" },
        },
        {
          label: "Fetch the Vertex operation",
          description:
            "Each read advances the operation one step: the first returns only its name, the second done with the MP4 inline as base64. Run Start a Vertex Veo operation first.",
          method: "POST",
          path: `${VERTEX_VEO}:fetchPredictOperation`,
          headers: JSON_HEADERS,
          body: json({ operationName: "{{vertex_operation}}" }),
        },
      ],
    },
    {
      title: "Decisions",
      presets: [
        {
          label: "Ask OpenAI questions",
          description:
            "Sends a yes or no question, a choice, and a score to OpenAI decisions. Answers come back in question order with probabilities for every option.",
          method: "POST",
          path: "/v1/decisions",
          headers: JSON_HEADERS,
          body: json({
            model: "gpt-6-luna",
            input: "The box arrived crushed and the screen is cracked.",
            questions: [
              { type: "predicate", name: "damaged", instructions: "Is the item damaged?" },
              {
                type: "choice",
                name: "team",
                instructions: "Which team should handle this?",
                choices: [{ value: "billing" }, { value: "shipping" }, { value: "technical" }],
              },
              {
                type: "score",
                name: "urgency",
                instructions: "How urgent is this?",
                levels: [{ label: "low" }, { label: "medium" }, { label: "high" }],
              },
            ],
          }),
        },
        {
          label: "Ask Gemini questions",
          description:
            "The Google wire format: questions are a map keyed by id and every question needs instructions. Each answer carries a confidence.",
          method: "POST",
          path: "/v1beta/decisions",
          headers: JSON_HEADERS,
          body: json({
            model: "gemini-decision-1",
            input: "Can I change the delivery address on my order?",
            questions: {
              is_question: { type: "noul", instructions: "Is the customer asking a question?" },
              topic: {
                type: "choice",
                instructions: "What is the message about?",
                criteria: { delivery: null, payment: null, returns: null },
              },
            },
          }),
        },
        {
          label: "Ask TypeSafe systemOne",
          description:
            "The TypeSafe format sends the context as state and choice options as a criteria map. A score comes back as an expected value with a legend and per-level probabilities.",
          method: "POST",
          path: "/v1/systemone",
          headers: JSON_HEADERS,
          body: json({
            model: "jev-latest",
            state: "The checkout page has been down for an hour.",
            questions: {
              outage: { type: "noul", instructions: "Is this an outage report?" },
              severity: { type: "score", criteria: ["minor", "major", "critical"] },
            },
          }),
        },
        {
          label: "Find a box with OpenRouter",
          description:
            "OpenRouter alpha decisions with a box question about an image URL. The answer is a bounding box with edges from 0 to 1.",
          method: "POST",
          path: "/api/alpha/decisions",
          headers: JSON_HEADERS,
          body: json({
            model: "typesafe/jev-latest",
            state: [{ type: "image_url", image_url: { url: "https://example.com/dog.png" } }],
            questions: { dog: { type: "box", instructions: "Where is the dog?" } },
          }),
        },
        {
          label: "Locate text with Perplexity",
          description:
            "Perplexity decisions with a locate question, which needs a string state. The answer lists text spans with character offsets and a score.",
          method: "POST",
          path: "/v1/decisions",
          headers: JSON_HEADERS,
          body: json({
            model: "pplx-decider-latest",
            state: "Order 4512 shipped on Monday to Berlin.",
            questions: {
              order_id: { type: "locate", instructions: "The order number" },
              shipped: { type: "noul", instructions: "Has the order shipped?" },
            },
          }),
        },
        {
          label: "Get a scripted answer",
          description:
            "The seeded refund-triage rule answers any decision whose input mentions charged twice, so the scripted answers come back with full confidence.",
          method: "POST",
          path: "/v1/systemone",
          headers: JSON_HEADERS,
          body: json({
            model: "jev-latest",
            state: "I was charged twice for one order.",
            questions: {
              team: { type: "choice", criteria: { billing: null, shipping: null, technical: null } },
              refund: { type: "noul", instructions: "Should we refund?" },
              urgency: { type: "score", criteria: ["low", "medium", "high"] },
            },
          }),
        },
      ],
    },
    {
      title: "Models and control",
      presets: [
        {
          label: "List models",
          description: "Lists the seeded models and every model an earlier request named. No input needed.",
          method: "GET",
          path: "/v1/models",
        },
        {
          label: "List rules",
          description: "Returns the active rules with their remaining budgets, in the shape PUT accepts.",
          method: "GET",
          path: "/_ai/rules",
        },
        {
          label: "List recorded calls",
          description: "Returns every generation request so far, oldest first, with the rule that answered it.",
          method: "GET",
          path: "/_ai/calls",
        },
        {
          label: "Restore the seed",
          description: "Restores the seeded rules, budgets, ids, call record, and stored responses.",
          method: "POST",
          path: "/_ai/reset",
        },
      ],
    },
  ],
};

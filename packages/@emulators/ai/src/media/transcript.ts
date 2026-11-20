/** One timed word of a transcript. */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

/** One timed sentence of a transcript. */
export interface TimedSegment {
  text: string;
  start: number;
  end: number;
  words: TimedWord[];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Spreads the words of `text` across `seconds` in proportion to their length, so timings repeat exactly. */
export function timedWords(text: string, seconds: number): TimedWord[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const total = words.reduce((sum, word) => sum + word.length + 1, 0);
  let at = 0;
  return words.map((word) => {
    const span = total === 0 ? 0 : ((word.length + 1) / total) * seconds;
    const timed = { word, start: round(at), end: round(at + span) };
    at += span;
    return timed;
  });
}

/** Groups timed words into sentences ending at `.`, `!`, or `?`. */
export function timedSegments(text: string, seconds: number): TimedSegment[] {
  const segments: TimedSegment[] = [];
  let current: TimedWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      text: current.map((word) => word.word).join(" "),
      start: current[0].start,
      end: current[current.length - 1].end,
      words: current,
    });
    current = [];
  };
  for (const word of timedWords(text, seconds)) {
    current.push(word);
    if (/[.!?]$/.test(word.word)) flush();
  }
  flush();
  return segments;
}

function clock(seconds: number, separator: string): string {
  const ms = Math.round(seconds * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

/** Renders segments as SubRip subtitles. */
export function toSrt(segments: TimedSegment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${clock(segment.start, ",")} --> ${clock(segment.end, ",")}\n${segment.text}\n`,
    )
    .join("\n");
}

/** Renders segments as WebVTT subtitles. */
export function toVtt(segments: TimedSegment[]): string {
  return `WEBVTT\n\n${segments.map((segment) => `${clock(segment.start, ".")} --> ${clock(segment.end, ".")}\n${segment.text}\n`).join("\n")}`;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "english",
  es: "spanish",
  fr: "french",
  de: "german",
  it: "italian",
  pt: "portuguese",
  nl: "dutch",
  ja: "japanese",
  ko: "korean",
  zh: "chinese",
  hi: "hindi",
  ar: "arabic",
  ru: "russian",
};

/** The language name Whisper reports for an ISO-639-1 code; unknown codes are returned as given. */
export function languageName(code: string | undefined): string {
  if (code === undefined) return "english";
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code;
}

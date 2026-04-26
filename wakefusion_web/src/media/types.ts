/** Shared types for the media presentation layer. */

export interface MediaRef {
  assetId: string;
  assetType: "image" | "video" | "audio" | "document" | "wiki" | string;
  url: string;
  label: string;
  frameUrl?: string;
  startMs?: number;
  endMs?: number;
  traceId?: string;
}

export type MediaKind = "video" | "image" | "document" | "audio" | "wiki" | null;

export type MediaMachineState = "idle" | "loading" | "playing" | "exiting";

export interface MediaHistoryEntry {
  id: string;
  ref: MediaRef;
  sourceTraceId?: string;
  startedAt: number;
  endedAt?: number;
  status: "playing" | "ended" | "stopped";
}

/** Determine the canonical media kind for a batch of refs. */
export function resolveMediaKind(refs: MediaRef[]): MediaKind {
  if (refs.length === 0) return null;
  const t = refs[0].assetType;
  if (t === "video") return "video";
  if (t === "audio") return "audio";
  if (t === "image") return "image";
  if (t === "document") return "document";
  if (t === "wiki") return "wiki";
  return null;
}

/** Check if an assetType should be displayed in the stage media layer. */
export function isPlayableMedia(assetType: string): boolean {
  return (
    assetType === "image" ||
    assetType === "video" ||
    assetType === "audio" ||
    assetType === "document" ||
    assetType === "wiki"
  );
}

/** Strip the URL fragment (e.g. #t=30) for use as a media src. */
export function stripPlaybackFragment(url: string): string {
  return url.split("#")[0];
}

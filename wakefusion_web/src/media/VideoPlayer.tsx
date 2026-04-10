import { Volume2 } from "lucide-react";
import type { MediaRef } from "./types";
import { stripPlaybackFragment } from "./types";

interface VideoPlayerProps {
  mediaRef: MediaRef;
  volume: number;
  onReady: () => void;
  onEnded: () => void;
  onInteraction: () => void;
}

/**
 * Plays a single video or audio asset full-screen.
 * On natural completion fires `onEnded` which the state machine uses to
 * transition back to the avatar idle screen.
 */
export function VideoPlayer({
  mediaRef,
  volume,
  onReady,
  onEnded,
  onInteraction,
}: VideoPlayerProps) {
  const playbackUrl = stripPlaybackFragment(mediaRef.url);

  if (mediaRef.assetType === "audio") {
    return (
      <div className="stage-media-body stage-media-audio-wrap" onClick={onInteraction}>
        <div className="stage-audio-visual">
          <Volume2 className="h-10 w-10" />
          <div>
            <strong>{mediaRef.label}</strong>
            <p>音频资料已切换到舞台区播放。</p>
          </div>
        </div>
        <audio
          src={playbackUrl}
          className="stage-media-audio"
          controls
          autoPlay
          preload="auto"
          onCanPlay={onReady}
          onPlaying={onReady}
          onEnded={onEnded}
          ref={(el) => {
            if (el) el.volume = volume;
          }}
        />
      </div>
    );
  }

  return (
    <div className="stage-media-body" onClick={onInteraction}>
      <video
        src={playbackUrl}
        className="stage-media-video"
        controls
        autoPlay
        playsInline
        preload="auto"
        poster={mediaRef.frameUrl}
        onCanPlay={onReady}
        onPlaying={onReady}
        onEnded={onEnded}
        ref={(el) => {
          if (el) el.volume = volume;
        }}
      />
    </div>
  );
}

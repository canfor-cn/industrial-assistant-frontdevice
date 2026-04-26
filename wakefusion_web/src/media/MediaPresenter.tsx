import type { MediaMachine } from "./useMediaStateMachine";
import { useInactivityTimeout } from "./useInactivityTimeout";
import { VideoPlayer } from "./VideoPlayer";
import { ImageCarousel } from "./ImageCarousel";
import { DocumentViewer } from "./DocumentViewer";
import { MarkdownTouchViewer } from "./MarkdownTouchViewer";

const INACTIVITY_TIMEOUT_MS = 60_000;

interface MediaPresenterProps {
  machine: MediaMachine;
  volume: number;
}

/**
 * Top-level media rendering container. Chooses the correct sub-component
 * based on `machine.mediaKind` and manages the 60 s inactivity timeout
 * for image / document types.
 */
export function MediaPresenter({ machine, volume }: MediaPresenterProps) {
  const { state, currentRefs, currentIndex, mediaKind } = machine;

  // Inactivity timeout for image / document / wiki while playing.
  const needsTimeout =
    state === "playing" &&
    (mediaKind === "image" || mediaKind === "document" || mediaKind === "wiki");

  const { resetTimer } = useInactivityTimeout(
    needsTimeout,
    INACTIVITY_TIMEOUT_MS,
    () => machine.dismiss("timeout"),
  );

  const handleInteraction = () => {
    resetTimer();
  };

  // Nothing to render when idle
  if (state === "idle" || currentRefs.length === 0) return null;

  const isVisible = state === "playing";
  const isLoading = state === "loading";
  const isExiting = state === "exiting";

  const handleClose = () => {
    machine.dismiss("user_close");
  };

  return (
    <div
      className={`stage-media-shell is-mounted ${isVisible ? "is-visible" : ""} ${isLoading ? "is-loading" : ""} ${isExiting ? "is-exiting" : ""}`}
    >
      {/* 关闭按钮 */}
      <button className="stage-media-close" onClick={handleClose} title="关闭">
        ✕
      </button>

      {mediaKind === "video" || mediaKind === "audio" ? (
        <VideoPlayer
          mediaRef={currentRefs[0]}
          volume={volume}
          onReady={machine.ready}
          onEnded={machine.ended}
          onInteraction={handleInteraction}
        />
      ) : mediaKind === "image" ? (
        <ImageCarousel
          refs={currentRefs}
          currentIndex={currentIndex}
          onIndexChange={machine.setIndex}
          onReady={machine.ready}
          onInteraction={handleInteraction}
        />
      ) : mediaKind === "document" ? (
        <DocumentViewer
          mediaRef={currentRefs[0]}
          onReady={machine.ready}
          onInteraction={handleInteraction}
        />
      ) : mediaKind === "wiki" ? (
        <MarkdownTouchViewer
          mediaRef={currentRefs[0]}
          onReady={machine.ready}
          onInteraction={handleInteraction}
        />
      ) : null}
    </div>
  );
}

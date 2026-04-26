"""
ArcFace face-embedding wrapper around InsightFace's `w600k_mbf.onnx`.

Standard pipeline:
  1. Caller passes a BGR image plus the 5 face landmarks already detected
     by YuNet (right_eye, left_eye, nose, right_mouth, left_mouth).
  2. We similarity-transform the crop to a 112x112 aligned face.
  3. ONNX returns a 512-d feature; we L2-normalize and return it.

Model file path is configurable; if the file is missing or onnxruntime is
unavailable, `FaceEmbedder.is_available()` is False and `embed()` returns None.
This keeps the device boot path resilient on machines that haven't synced the
model directory yet.
"""

from __future__ import annotations

import logging
import os
from typing import List, Optional, Sequence, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# Standard ArcFace destination landmarks (112x112 image, RGB convention used by
# InsightFace). Source: InsightFace official preprocess.
_ARCFACE_DST: np.ndarray = np.array(
    [
        [38.2946, 51.6963],  # right eye
        [73.5318, 51.5014],  # left eye
        [56.0252, 71.7366],  # nose
        [41.5493, 92.3655],  # right mouth
        [70.7299, 92.2041],  # left mouth
    ],
    dtype=np.float32,
)


class FaceEmbedder:
    """Loads `w600k_mbf.onnx` once and produces L2-normed 512-d vectors."""

    def __init__(self, model_path: str):
        self.model_path = model_path
        self._session = None
        self._input_name = None
        self._cv2 = None

        if not os.path.isfile(model_path):
            logger.warning("FaceEmbedder model not found: %s", model_path)
            return

        try:
            import onnxruntime as ort  # type: ignore

            providers = ["CPUExecutionProvider"]
            self._session = ort.InferenceSession(model_path, providers=providers)
            self._input_name = self._session.get_inputs()[0].name
        except Exception as exc:
            logger.exception("FaceEmbedder failed to load %s: %s", model_path, exc)
            self._session = None
            return

        try:
            import cv2  # type: ignore

            self._cv2 = cv2
        except Exception as exc:
            logger.warning("OpenCV not available; face alignment disabled: %s", exc)
            self._session = None  # alignment requires cv2

    def is_available(self) -> bool:
        return self._session is not None and self._cv2 is not None

    def embed(
        self,
        image_bgr: np.ndarray,
        landmarks_xy: Sequence[Tuple[float, float]],
    ) -> Optional[np.ndarray]:
        """Return a 512-d L2-normed embedding, or None on failure / unavailable.

        - `image_bgr`: HxWx3 uint8 BGR (OpenCV style).
        - `landmarks_xy`: 5 (x, y) tuples in pixel coords, in the order
          right_eye, left_eye, nose, right_mouth, left_mouth.
        """
        if not self.is_available():
            return None
        if image_bgr is None or image_bgr.size == 0:
            return None
        if len(landmarks_xy) != 5:
            logger.warning("FaceEmbedder requires 5 landmarks, got %d", len(landmarks_xy))
            return None

        cv2 = self._cv2
        src = np.array(landmarks_xy, dtype=np.float32)
        try:
            tform, _ = cv2.estimateAffinePartial2D(src, _ARCFACE_DST, method=cv2.LMEDS)
            if tform is None:
                return None
            aligned = cv2.warpAffine(image_bgr, tform, (112, 112), borderValue=0)
        except Exception as exc:
            logger.warning("face alignment failed: %s", exc)
            return None

        # BGR → RGB, normalize to [-1, 1] (InsightFace convention).
        rgb = cv2.cvtColor(aligned, cv2.COLOR_BGR2RGB).astype(np.float32)
        rgb = (rgb - 127.5) / 127.5
        # HWC → BCHW
        blob = np.transpose(rgb, (2, 0, 1))[np.newaxis, :, :, :]

        try:
            outputs = self._session.run(None, {self._input_name: blob})
        except Exception as exc:
            logger.warning("face embedding inference failed: %s", exc)
            return None

        feat = outputs[0]
        if feat.ndim == 2:
            feat = feat[0]
        feat = np.asarray(feat, dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(feat))
        if norm <= 0.0:
            return None
        return feat / norm


def average_embeddings(embeddings: List[np.ndarray]) -> Optional[np.ndarray]:
    """Mean of N L2-normed vectors, then re-normed. Returns None if empty."""
    valid = [e for e in embeddings if e is not None and e.size > 0]
    if not valid:
        return None
    stacked = np.stack(valid, axis=0).astype(np.float32)
    mean = stacked.mean(axis=0)
    norm = float(np.linalg.norm(mean))
    if norm <= 0.0:
        return None
    return mean / norm

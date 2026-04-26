"""
WeSpeaker voice-embedding wrapper around `voxceleb_resnet34_LM.onnx`.

Pipeline:
  1. Caller hands us 16 kHz mono PCM (numpy float32 in [-1, 1] OR int16).
  2. We preemphasize, frame, hamming-window, FFT, take power spectrum,
     fold into 80 mel bins (kaldi-style HTK), log.
  3. Optional cepstral mean subtraction (per utterance) — wespeaker recipe
     trains with it on, so we keep it on by default.
  4. ONNX produces a 256-d d-vector; we L2-normalize and return it.

Pure numpy + onnxruntime, no librosa / torchaudio dependency. The fbank
implementation matches kaldi's `compute-fbank-feats --num-mel-bins=80
--frame-length=25 --frame-shift=10 --sample-frequency=16000` closely enough
for embedding cosine-similarity to behave as expected.
"""

from __future__ import annotations

import logging
import math
import os
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
FRAME_LENGTH_MS = 25
FRAME_SHIFT_MS = 10
NUM_MEL_BINS = 80
PREEMPHASIS = 0.97
LOW_FREQ_HZ = 20.0
HIGH_FREQ_HZ = SAMPLE_RATE / 2  # 8000


# ── Mel filterbank (kaldi/HTK style) ─────────────────────────────────────────

def _hz_to_mel(hz: float) -> float:
    # Kaldi uses HTK mel: m = 1127 * ln(1 + f / 700)
    return 1127.0 * math.log1p(hz / 700.0)


def _mel_to_hz(mel: float) -> float:
    return 700.0 * (math.expm1(mel / 1127.0))


def _build_mel_filterbank(num_bins: int, n_fft: int, sr: int) -> np.ndarray:
    low_mel = _hz_to_mel(LOW_FREQ_HZ)
    high_mel = _hz_to_mel(HIGH_FREQ_HZ)
    mel_points = np.linspace(low_mel, high_mel, num_bins + 2)
    hz_points = np.array([_mel_to_hz(m) for m in mel_points], dtype=np.float64)
    bin_freqs = np.linspace(0, sr / 2, n_fft // 2 + 1)

    fb = np.zeros((num_bins, n_fft // 2 + 1), dtype=np.float32)
    for i in range(num_bins):
        left, center, right = hz_points[i], hz_points[i + 1], hz_points[i + 2]
        for j, f in enumerate(bin_freqs):
            if f < left or f > right:
                continue
            if f <= center:
                fb[i, j] = (f - left) / max(center - left, 1e-9)
            else:
                fb[i, j] = (right - f) / max(right - center, 1e-9)
    return fb


def _next_pow2(x: int) -> int:
    n = 1
    while n < x:
        n <<= 1
    return n


def compute_fbank(
    pcm: np.ndarray,
    sample_rate: int = SAMPLE_RATE,
    num_mel_bins: int = NUM_MEL_BINS,
) -> np.ndarray:
    """16 kHz mono float32 PCM -> (T, 80) log-mel features."""
    if pcm.dtype == np.int16:
        pcm = pcm.astype(np.float32) / 32768.0
    elif pcm.dtype != np.float32:
        pcm = pcm.astype(np.float32)
    pcm = pcm.reshape(-1)

    if sample_rate != SAMPLE_RATE:
        raise ValueError(f"voice_embedder expects {SAMPLE_RATE} Hz, got {sample_rate}")

    frame_length = int(round(FRAME_LENGTH_MS / 1000.0 * sample_rate))  # 400
    frame_shift = int(round(FRAME_SHIFT_MS / 1000.0 * sample_rate))    # 160
    n_fft = _next_pow2(frame_length)                                    # 512

    if pcm.size < frame_length:
        pad = np.zeros(frame_length - pcm.size, dtype=np.float32)
        pcm = np.concatenate([pcm, pad])

    # Preemphasis
    pre = np.empty_like(pcm)
    pre[0] = pcm[0]
    pre[1:] = pcm[1:] - PREEMPHASIS * pcm[:-1]

    # Frame using stride trick
    n_frames = 1 + (pre.size - frame_length) // frame_shift
    if n_frames <= 0:
        return np.zeros((0, num_mel_bins), dtype=np.float32)

    indexer = (
        np.tile(np.arange(frame_length), (n_frames, 1))
        + np.tile(np.arange(n_frames) * frame_shift, (frame_length, 1)).T
    )
    frames = pre[indexer]

    # Hamming window
    window = np.hamming(frame_length).astype(np.float32)
    frames = frames * window

    # Power spectrum (zero-padded to n_fft)
    spec = np.fft.rfft(frames, n=n_fft)
    power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32)

    # Mel projection + log
    fb = _build_mel_filterbank(num_mel_bins, n_fft, sample_rate)
    mel = power @ fb.T  # (T, num_mel_bins)
    mel = np.maximum(mel, 1.0e-10)
    log_mel = np.log(mel).astype(np.float32)

    return log_mel  # shape: (T, 80)


# ── ONNX wrapper ─────────────────────────────────────────────────────────────


class VoiceEmbedder:
    """Loads voxceleb_resnet34_LM.onnx and produces 256-d L2-normed vectors."""

    def __init__(self, model_path: str, cms: bool = True):
        self.model_path = model_path
        self.cms = cms
        self._session = None
        self._input_name = None

        if not os.path.isfile(model_path):
            logger.warning("VoiceEmbedder model not found: %s", model_path)
            return

        try:
            import onnxruntime as ort  # type: ignore

            self._session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
            self._input_name = self._session.get_inputs()[0].name
        except Exception as exc:
            logger.exception("VoiceEmbedder failed to load %s: %s", model_path, exc)
            self._session = None

    def is_available(self) -> bool:
        return self._session is not None

    def embed(self, pcm_16k_mono: np.ndarray) -> Optional[np.ndarray]:
        """Return a 256-d L2-normed embedding from raw 16 kHz mono PCM."""
        if not self.is_available():
            return None
        if pcm_16k_mono is None or pcm_16k_mono.size == 0:
            return None

        try:
            feats = compute_fbank(pcm_16k_mono)
        except Exception as exc:
            logger.warning("voice fbank failed: %s", exc)
            return None
        if feats.shape[0] == 0:
            return None

        if self.cms:
            feats = feats - feats.mean(axis=0, keepdims=True)

        # ONNX wants (B, T, 80)
        blob = feats[np.newaxis, :, :].astype(np.float32)
        try:
            outputs = self._session.run(None, {self._input_name: blob})
        except Exception as exc:
            logger.warning("voice embedding inference failed: %s", exc)
            return None

        emb = outputs[0]
        if emb.ndim == 2:
            emb = emb[0]
        emb = np.asarray(emb, dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(emb))
        if norm <= 0.0:
            return None
        return emb / norm

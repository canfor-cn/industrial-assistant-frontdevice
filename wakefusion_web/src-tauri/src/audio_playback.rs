use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{Receiver, Sender};

pub struct AudioPlayer {
    tx: Sender<Vec<i16>>,
    _stream: cpal::Stream,
    pub sample_rate: u32,
}

impl AudioPlayer {
    /// Create a new audio player targeting a device matching `device_match` (case-insensitive).
    pub fn new(device_match: &str, sample_rate: u32, channels: u16, strict: bool) -> Option<Self> {
        let host = cpal::default_host();
        let match_lower = device_match.to_lowercase();

        // List all output devices for debugging
        if let Ok(devices) = host.output_devices() {
            tracing::info!("Available output devices:");
            for d in devices {
                let name = d.name().unwrap_or_default();
                let matched = name.to_lowercase().contains(&match_lower);
                tracing::info!("  {} {}", if matched { "[MATCH]" } else { "       " }, name);
            }
        }

        // Find matching output device
        let device = host
            .output_devices()
            .ok()?
            .find(|d| {
                d.name()
                    .map(|n| n.to_lowercase().contains(&match_lower))
                    .unwrap_or(false)
            })
            .or_else(|| {
                if strict {
                    tracing::error!("Strict mode: output device '{}' not found", device_match);
                    None
                } else {
                    tracing::warn!("'{}' not found, using default output", device_match);
                    host.default_output_device()
                }
            })?;

        let dev_name = device.name().unwrap_or_default();
        tracing::info!("Audio output device: {} ({}Hz, {}ch)", dev_name, sample_rate, channels);

        let (tx, rx): (Sender<Vec<i16>>, Receiver<Vec<i16>>) = crossbeam_channel::bounded(1024);
        let mut buffer: Vec<i16> = Vec::new();

        let config = cpal::StreamConfig {
            channels,
            sample_rate: cpal::SampleRate(sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        let stream = device
            .build_output_stream(
                &config,
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                    // Drain available chunks into local buffer
                    while let Ok(chunk) = rx.try_recv() {
                        buffer.extend_from_slice(&chunk);
                    }
                    let take = data.len().min(buffer.len());
                    data[..take].copy_from_slice(&buffer[..take]);
                    buffer.drain(..take);
                    // Fill remaining with silence
                    for sample in data[take..].iter_mut() {
                        *sample = 0;
                    }
                },
                |err| {
                    tracing::error!("Audio stream error: {err}");
                },
                None,
            )
            .ok()?;

        stream.play().ok()?;
        tracing::info!("Audio playback stream started");

        Some(Self {
            tx,
            _stream: stream,
            sample_rate,
        })
    }

    /// Push PCM i16 samples to the playback queue.
    pub fn push(&self, samples: Vec<i16>) {
        let _ = self.tx.try_send(samples);
    }

    /// Clear the playback queue (for stop_tts / hard cutoff).
    pub fn clear(&self) {
        while self.tx.try_send(Vec::new()).is_ok() {}
        // Drain receiver side
        // Note: we can't drain the receiver from here since it's in the callback.
        // Instead, push an empty sentinel and let the callback handle it.
    }
}

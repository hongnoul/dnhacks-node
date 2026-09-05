# model.py — CRNN drone classifier (AntoineNaccache/drone-audio-detector).
# score_wav(path) → max drone probability over 1s windows at 500ms hop.
# Front-end contract from the model card: 16kHz mono, 64 mels, n_fft=512,
# hop=160, 50–5500 Hz, normalize (dB+40)/40.

from __future__ import annotations

from pathlib import Path

import torch
import torch.nn as nn
import torchaudio
import torchaudio.transforms as T

CKPT = Path(__file__).parent / "models" / "drone_classifier_aug_mixed.pt"
SR = 16_000
WINDOW = SR  # 1 s
HOP = SR // 2  # 500 ms

# Scoring gain normalization: peak-normalize each 1s window to NORM_PEAK.
# Real noise clips have peak >= 0.19; only digital silence falls below
# PEAK_FLOOR, and those windows score 0 without amplification.
NORM_PEAK = 0.9
PEAK_FLOOR = 0.005


def _conv_block(in_ch, out_ch):
    return nn.Sequential(
        nn.Conv2d(in_ch, out_ch, 3, padding=1, bias=False), nn.BatchNorm2d(out_ch), nn.ReLU(True),
        nn.Conv2d(out_ch, out_ch, 3, padding=1, bias=False), nn.BatchNorm2d(out_ch), nn.ReLU(True),
    )


class DroneClassifier(nn.Module):
    def __init__(self):
        super().__init__()
        self.enc1 = _conv_block(1, 32); self.pool1 = nn.MaxPool2d(2, 2)
        self.enc2 = _conv_block(32, 64); self.pool2 = nn.MaxPool2d(2, 2)
        self.enc3 = _conv_block(64, 128); self.pool3 = nn.MaxPool2d((2, 1), (2, 1))
        self.gru = nn.GRU(1024, 128, num_layers=2, batch_first=True,
                          bidirectional=True, dropout=0.2)
        self.head = nn.Sequential(nn.Linear(256, 64), nn.ReLU(True),
                                  nn.Dropout(0.3), nn.Linear(64, 1))

    def forward(self, x):
        x = self.pool1(self.enc1(x))
        x = self.pool2(self.enc2(x))
        x = self.pool3(self.enc3(x))
        b, c, f, t = x.shape
        x, _ = self.gru(x.permute(0, 3, 1, 2).reshape(b, t, c * f))
        return self.head(x.mean(1))


_mel = T.MelSpectrogram(
    sample_rate=SR, n_fft=512, hop_length=160, n_mels=64, f_min=50, f_max=5_500
)
_to_db = T.AmplitudeToDB()

_model: DroneClassifier | None = None


def get_model() -> DroneClassifier:
    global _model
    if _model is None:
        m = DroneClassifier()
        state = torch.load(CKPT, map_location="cpu", weights_only=False)
        if "model_state_dict" in state:
            state = state["model_state_dict"]
        # Checkpoint is a multi-task model: encoder.* + classifier.fc.* + separator.*
        # Remap onto this classifier-only class; drop the separator branch.
        remapped = {}
        for k, v in state.items():
            if k.startswith("encoder."):
                remapped[k[len("encoder."):]] = v  # enc1/enc2/enc3/gru
            elif k.startswith("classifier.fc."):
                remapped["head." + k[len("classifier.fc."):]] = v
        m.load_state_dict(remapped, strict=True)  # strict: fail loudly on mismatch
        m.eval()
        _model = m
    return _model


@torch.no_grad()
def score_waveform(wave: torch.Tensor, sr: int) -> float:
    """wave: (channels, samples). Returns max drone prob over 1s windows.

    Each window is peak-normalized to NORM_PEAK before the mel front end:
    room playback lands 20-30 dB below file level, and the fixed
    (dB+40)/40 normalization shifts quiet audio into a range the CRNN
    never saw in training (1.0 at full level → 0.06 at -30 dB).
    Windows below PEAK_FLOOR are near-digital-silence — return 0 rather
    than amplifying noise into a false verdict.
    """
    if sr != SR:
        wave = torchaudio.functional.resample(wave, sr, SR)
    wave = wave.mean(0, keepdim=True)  # mono
    n = wave.shape[1]
    if n < WINDOW:  # pad short input to one window
        wave = torch.nn.functional.pad(wave, (0, WINDOW - n))
        n = WINDOW
    model = get_model()
    probs = []
    for start in range(0, n - WINDOW + 1, HOP):
        chunk = wave[:, start:start + WINDOW]
        peak = chunk.abs().max().item()
        if peak < PEAK_FLOOR:
            probs.append(0.0)
            continue
        chunk = chunk * (NORM_PEAK / peak)
        log_mel = (_to_db(_mel(chunk)) + 40) / 40
        probs.append(torch.sigmoid(model(log_mel.unsqueeze(0))).item())
    return max(probs)


def score_wav(path: str | Path) -> float:
    # stdlib WAV reader — avoids torchaudio backend deps; clips are 16-bit PCM mono
    import wave as wave_mod

    import numpy as np

    with wave_mod.open(str(path), "rb") as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        raw = w.readframes(w.getnframes())
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if nch > 1:
        data = data.reshape(-1, nch).mean(1)
    return score_waveform(torch.from_numpy(data).unsqueeze(0), sr)

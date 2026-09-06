# export_onnx.py — export the CRNN classifier to ONNX for on-device (browser)
# inference via onnxruntime-web.
#
# Input contract (matches model.py front end, computed in TS on the phone):
#   log_mel: float32 [batch, 1, 64, T]  where T = 1 + floor((samples - n_fft)/hop)
#            values already normalized: (amplitude_to_db(mel) + 40) / 40
# Output: logit float32 [batch, 1] — apply sigmoid client-side.
#
# Usage: .venv/bin/python export_onnx.py  → ../public/drone_crnn.onnx

from __future__ import annotations

from pathlib import Path

import torch

from model import WINDOW, get_model, _mel, _to_db

OUT = Path(__file__).parent.parent / "public" / "drone_crnn.onnx"


def main() -> None:
    model = get_model()  # loads + remaps checkpoint, eval mode

    # Trace with a realistic 1s-window mel input: (1, 1, 64, 101)
    dummy_wave = torch.zeros(1, WINDOW)
    log_mel = (_to_db(_mel(dummy_wave)) + 40) / 40
    dummy = log_mel.unsqueeze(0)  # (1, 1, 64, T)
    print(f"trace input shape: {tuple(dummy.shape)}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        dummy,
        str(OUT),
        input_names=["log_mel"],
        output_names=["logit"],
        dynamic_axes={"log_mel": {0: "batch"}, "logit": {0: "batch"}},
        opset_version=17,
        dynamo=False,  # classic exporter: GRU exports as ONNX GRU op
    )
    size_mb = OUT.stat().st_size / 1e6
    print(f"wrote {OUT} ({size_mb:.1f} MB)")

    # Parity check: ONNX output vs PyTorch on random input
    import numpy as np
    import onnxruntime as ort

    x = torch.randn(1, 1, 64, 101)
    with torch.no_grad():
        ref = torch.sigmoid(model(x)).item()
    sess = ort.InferenceSession(str(OUT))
    out = sess.run(None, {"log_mel": x.numpy()})[0]
    got = 1 / (1 + np.exp(-out[0, 0]))
    print(f"parity: torch={ref:.6f} onnx={got:.6f} diff={abs(ref-got):.2e}")
    assert abs(ref - got) < 1e-4, "ONNX/PyTorch mismatch"
    print("OK")


if __name__ == "__main__":
    main()

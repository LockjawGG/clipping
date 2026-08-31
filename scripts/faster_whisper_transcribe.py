"""
Transcribe one file with faster-whisper and print the result as JSON.

faster-whisper is the same Whisper weights run through CTranslate2 instead of
PyTorch. On this project's CPU-only setup that is roughly twice as fast per job
for output that matched the reference engine character for character on the
samples it was checked against.

Two settings are load-bearing and deliberately not exposed as knobs:

  compute_type=float32   The int8 quantisations are much faster and measurably
                         wrong. On a 66s Korean clip int8 replaced two whole
                         phrases with a repeat of an earlier one; on a 24s
                         English clip it hallucinated a repeated segment.
                         Quantisation is where the quality goes.

  vad_filter=False       Voice-activity filtering looked like a free 40% until
                         it silently dropped the second half of that same
                         Korean clip. Speech it decides is not speech is gone
                         with no error to notice.

The output shape mirrors the whisper CLI's JSON so the existing parser handles
both engines unchanged.
"""

import json
import sys

from faster_whisper import WhisperModel


def main() -> int:
    args = json.loads(sys.argv[1])

    model = WhisperModel(
        args["model"],
        device="cpu",
        compute_type=args.get("compute_type", "float32"),
    )

    segments, info = model.transcribe(
        args["audio"],
        beam_size=args.get("beam_size", 5),
        word_timestamps=True,
        # Carry context across segments, matching the reference engine.
        condition_on_previous_text=True,
        vad_filter=False,
        language=args.get("language") or None,
        task=args.get("task") or "transcribe",
        initial_prompt=args.get("initial_prompt") or None,
    )

    out = []
    for s in segments:
        out.append(
            {
                "start": s.start,
                "end": s.end,
                "text": s.text,
                "avg_logprob": s.avg_logprob,
                "words": [
                    {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
                    for w in (s.words or [])
                ],
            }
        )

    # Written to stdout as UTF-8 bytes rather than print(): the console encoding
    # on Windows is cp1252, and printing a non-Latin transcript through it makes
    # the whole run fail with UnicodeEncodeError.
    payload = json.dumps({"language": info.language, "segments": out}, ensure_ascii=False)
    sys.stdout.buffer.write(payload.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

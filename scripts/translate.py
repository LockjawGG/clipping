"""
Offline text translation via Argos Translate.

Reads JSON Lines on stdin ({"id": "...", "text": "..."}), writes the same
shape with translated text on stdout, order preserved. Missing language
packages are downloaded on first use (one time, ~150-250 MB per pair).

  python translate.py --from ko --to es < segments.jsonl > out.jsonl

Argos auto-pivots through English when there is no direct pair, so any
supported source can reach any supported target.
"""
import argparse
import json
import sys

# whisper-local hits this same wall on Windows: the console is cp1252, and any
# non-Latin output raises UnicodeEncodeError. Force UTF-8 on every stream.
for s in (sys.stdin, sys.stdout, sys.stderr):
    try:
        s.reconfigure(encoding="utf-8")
    except Exception:
        pass

import argostranslate.package as pkg
import argostranslate.translate as tr


def ensure_pair(from_code: str, to_code: str) -> None:
    installed = {(p.from_code, p.to_code) for p in pkg.get_installed_packages()}
    need = []
    if (from_code, to_code) not in installed:
        # direct pair, or the two legs of an English pivot
        need = [(from_code, to_code)]
        if from_code != "en" and to_code != "en":
            need = [(from_code, "en"), ("en", to_code)]

    missing = [n for n in need if n not in installed]
    if not missing:
        return

    pkg.update_package_index()
    avail = pkg.get_available_packages()
    for fc, tc in missing:
        match = next((p for p in avail if p.from_code == fc and p.to_code == tc), None)
        if match is None:
            # fall back to a pivot if a requested direct pair isn't published
            if fc != "en" and tc != "en":
                ensure_pair(fc, "en")
                ensure_pair("en", tc)
                return
            raise SystemExit(f"no Argos package for {fc}->{tc}")
        pkg.install_from_path(match.download())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True)
    ap.add_argument("--to", dest="dst", required=True)
    args = ap.parse_args()

    if args.src == args.dst:
        # nothing to do — echo through
        for line in sys.stdin:
            line = line.strip()
            if line:
                sys.stdout.write(line + "\n")
        return

    ensure_pair(args.src, args.dst)

    rows = [json.loads(line) for line in sys.stdin if line.strip()]
    for row in rows:
        text = (row.get("text") or "").strip()
        out = tr.translate(text, args.src, args.dst) if text else ""
        sys.stdout.write(json.dumps({"id": row["id"], "text": out}, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

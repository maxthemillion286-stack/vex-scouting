# Checks for the desktop app

Run by hand from a scratch folder; paths inside point at the checkout they were
written against (`/home/claude/vex-scouting`), so change those first.

- `parity.py` then `parity.mjs`: the Python port of colour, look, plate box,
  frame packing, plate matching, match names and the clock gives the same
  answers as the functions in `index.html` (305 comparisons).
- `e2e.py`: a made-up match video through the whole app against a stand-in
  website: models load, overlay read, a match tracked, frames kept, review
  server, training set, scoring, publishing in parts. Needs
  `run/vex_trainer.py` and `run/models/*.onnx` copied in first.
- `val.mjs`: what `e2e.py` posted is accepted by `api/tracker.js`.

Not covered anywhere: DirectML on a real graphics card, yt-dlp downloads, and
training (PyTorch + ultralytics). Those first ran on the owner's machine.

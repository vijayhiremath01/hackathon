# ReBin

Local waste object detection engine using Python, YOLO, and OpenCV. Captures images from a webcam, runs object detection, and saves structured JSON records with integrity hashes.

## What It Does

1. Opens your webcam and shows a live preview
2. Press **SPACE** to capture a single photograph
3. Releases the webcam immediately
4. Runs YOLOv8n (yolo26n.pt) object detection on the captured image
5. Generates a JSON record with detections, metadata, and SHA-256 hash
6. Saves the original image, annotated preview, and JSON record in date-organized directories
7. Returns to preview for another scan

## Project Structure

```
waste-cv-engine/
├── models/
│   └── yolo26n.pt              # YOLO model (general object detector)
├── captured_images/
│   └── YYYY/MM/DD/             # Original photographs
├── scan_records/
│   └── YYYY/MM/DD/             # JSON detection records
├── detection_previews/
│   └── YYYY/MM/DD/             # Annotated images with bounding boxes
├── logs/
├── src/
│   └── waste_cv_engine/
│       ├── __init__.py
│       ├── config.py           # Configuration settings
│       ├── camera.py           # Webcam capture
│       ├── detector.py         # YOLO inference
│       ├── material_classifier.py  # Material classification (unknown by default)
│       ├── record_writer.py    # JSON record generation
│       └── integrity.py        # SHA-256 hashing & secure writes
├── tests/
│   ├── test_record_writer.py
│   ├── test_integrity.py
│   └── test_material_classifier.py
├── main.py                     # Entry point
├── .gitignore
├── pyproject.toml
├── requirements.txt
└── README.md
```

## Requirements

- Python 3.13+
- Existing virtual environment with dependencies installed (see `requirements.txt`)

Key dependencies:
- `ultralytics` (YOLO)
- `torch` / `torchvision`
- `opencv-python`
- `numpy`
- `pillow`

## Setup

The project uses an existing virtual environment. Activate it:

```bash
cd waste-cv-engine
source .venv/bin/activate
```

Verify the model exists:

```bash
ls models/yolo26n.pt
```

## Running the Application

```bash
python main.py
```

Run from the project root directory (`waste-cv-engine/`).

### Keyboard Controls

| Key | Action |
|-----|--------|
| `SPACE` | Capture photo and run detection |
| `Q` / `ESC` | Quit application |
| `C` | Cancel current capture, return to preview |

### Output Locations

All outputs are organized by UTC date:

```
captured_images/2026/10/15/<scan_id>.jpg
scan_records/2026/10/15/<scan_id>.json
detection_previews/2026/10/15/<scan_id>_annotated.jpg
```

Each scan gets a unique UUID v4 identifier (e.g., `550e8400-e29b-41d4-a716-446655440000`).

## JSON Record Schema

```json
{
  "schema_version": "1.0",
  "scan_id": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-10-15T08:30:12.125Z",
  "completed_at": "2026-10-15T08:30:15.450Z",
  "status": "completed",
  "capture": {
    "source": "webcam",
    "image_path": "captured_images/2026/10/15/550e8400-e29b-41d4-a716-446655440000.jpg",
    "format": "JPEG",
    "width": 1280,
    "height": 720,
    "sha256": "a1b2c3d4e5f6..."
  },
  "model": {
    "name": "YOLO26 Nano",
    "weights_path": "models/yolo26n.pt",
    "task": "object_detection",
    "confidence_threshold": 0.25
  },
  "detections": [
    {
      "class_id": 39,
      "label": "bottle",
      "confidence": 0.92,
      "bounding_box": { "x1": 100, "y1": 120, "x2": 250, "y2": 400 },
      "material": {
        "category": "unknown",
        "status": "not_classified",
        "method": null,
        "confidence": null
      }
    }
  ],
  "summary": {
    "total_detections": 1,
    "unique_object_classes": ["bottle"]
  },
  "artifacts": {
    "original_image": "captured_images/2026/10/15/550e8400-e29b-41d4-a716-446655440000.jpg",
    "json_record": "scan_records/2026/10/15/550e8400-e29b-41d4-a716-446655440000.json",
    "annotated_image": "detection_previews/2026/10/15/550e8400-e29b-41d4-a716-446655440000_annotated.jpg"
  },
  "errors": []
}
```

All paths are relative to the project root for portability.

## SHA-256 Integrity Verification

Each JSON record includes a SHA-256 hash of the **exact saved original image bytes**.

### Verification

```python
from waste_cv_engine.integrity import verify_integrity
from pathlib import Path

result = verify_integrity(
    Path("captured_images/2026/10/15/scan_id.jpg"),
    "expected_sha256_from_json"
)
print(result.verified)  # True if unchanged
```

### Important Security Note

> **SHA-256 detects content changes only when the expected hash is itself trusted.**
> 
> The hash stored in the JSON record is generated at write time. If an attacker can modify both the image file AND the JSON record, they can make the hash match. This system provides **integrity detection** (detecting accidental corruption or unauthorized changes when you have a trusted copy of the JSON), not **tamper-proofing**. For true tamper-proofing, store hashes in a separate immutable log or use digital signatures.

## Material Classification Limitation

**The provided `yolo26n.pt` model is a general-purpose COCO object detector.** It detects classes such as "bottle", "cup", and "book" — **not materials** like "plastic", "glass", "paper", or "metal". COCO does not include a `can` or `page` class.

A detected "bottle" could be plastic, glass, or metal. The model has not been trained or validated for material identification.

The inference path uses a higher input resolution, test-time augmentation on the full frame, and overlapping crops to give small or partly obscured objects more pixels. This can improve detection of classes the checkpoint already knows; it cannot teach new classes. COCO does not define `page` or `paper sheet` as object labels, so a page may be missed or mislabeled even when inference succeeds. Reliable page and recycling-material recognition requires a custom detector trained with representative, labeled campus images.

The default checkpoint remains `models/yolo26n.pt`. To use a stronger or custom checkpoint without changing code, set `WASTE_CV_MODEL_PATH` to its path in the environment used by the backend (the backend passes its environment through to Python). Optional tuning:

- `WASTE_CV_IMAGE_SIZE` — inference resolution; defaults to `960`.
- `WASTE_CV_TTA` — full-frame test-time augmentation; defaults to `true`.
- `WASTE_CV_TILED_INFERENCE` — overlapping crop pass; defaults to `true`.
- `WASTE_CV_TILE_FRACTION` — crop size relative to the frame; defaults to `0.72`.

### Current Behavior

- All detections receive `"category": "unknown"`
- `"status": "not_classified"`
- `"method": null`
- `"confidence": null`

### Future Integration

The `MaterialClassifier` class in `material_classifier.py` is designed for future extension:

```python
from waste_cv_engine.material_classifier import MaterialClassifier

classifier = MaterialClassifier()

# Option 1: Register explicit rules
classifier.register_rule("aluminum_can", "metal", "rule_based")

# Option 2: Plug in a material-specific model later
classifier.set_material_model(your_material_model)
```

This keeps object detection and material classification separate.

## Running Tests

Tests mock camera and model — no webcam or downloads required.

```bash
python -m pytest tests/ -v
```

### Test Coverage

- Unique UUID scan IDs
- Valid UTC timestamps (ISO 8601 with Z)
- JSON schema compliance and serialization
- Correct relative paths
- SHA-256 calculation and verification
- Integrity verification (success and failure)
- Modified file detection
- Overwrite prevention
- Empty detections handling
- Unknown material classification
- Inference failure handling
- Record-writing failure handling

## Configuration

Edit `src/waste_cv_engine/config.py` to adjust:

- `model_path`: Path to YOLO weights
- `camera_index`: Webcam index (default 0)
- `confidence_threshold`: Detection confidence (default 0.25)
- `inference_image_size`: Prediction resolution (default 960)
- `test_time_augmentation`: Full-frame inference augmentation (default enabled)
- `tiled_inference`: Overlapping crops for small objects (default enabled)
- Output directories
- `jpeg_quality`: Image quality (default 95)
- `save_annotated_previews`: Enable/disable annotated images
- `log_level`: Logging verbosity

## Logging

Logs written to `logs/waste_cv_engine.log` and stdout.

Logged events:
- Application startup/shutdown
- Model loading
- Camera initialization
- Scan ID and status
- Detection count
- Record writing
- Integrity verification

## Error Handling

- Camera errors: Clear messages, graceful fallback
- Missing model: Startup failure with guidance
- Inference failures: Failure record written, original image preserved
- File write errors: Atomic writes, temp file cleanup, no overwrites
- Invalid images: Validation with descriptive errors

## Limitations

1. **No material classification** — General YOLO model cannot identify materials
2. **Single camera only** — Uses index 0 by default
3. **Local only** — No API, database, or cloud integration
4. **Blocking capture** — One scan at a time
5. **No GPU requirement** — Runs on CPU (uses torch CPU)

## License

MIT License — see LICENSE file if present.

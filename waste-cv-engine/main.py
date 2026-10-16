#!/usr/bin/env python3
"""Main entry point for waste-cv-engine.

Supports two modes:
  - Webcam mode (default): live preview, SPACE to capture, Q/ESC to quit.
  - CLI mode (--image /path/to/image.jpg): process a single image file,
    print structured JSON to stdout, send diagnostics to stderr.
"""

import argparse
import json
import logging
import sys
from pathlib import Path
from collections import Counter

from waste_cv_engine.config import CONFIG
from waste_cv_engine.camera import capture_single_image
from waste_cv_engine.detector import YOLODetector, create_annotated_image, Detection
from waste_cv_engine.record_writer import (
    write_scan_record,
    write_failure_record,
    _generate_scan_id,
    _utc_now_iso,
)
from waste_cv_engine.integrity import calculate_sha256


def setup_logging(to_stderr: bool = True) -> None:
    """Configure application logging. Logs go to stderr by default so stdout stays clean JSON."""
    CONFIG.logs_dir.mkdir(parents=True, exist_ok=True)

    log_format = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
    date_format = "%Y-%m-%d %H:%M:%S"

    handlers: list[logging.Handler] = [
        logging.FileHandler(CONFIG.logs_dir / "waste_cv_engine.log"),
    ]
    if to_stderr:
        handlers.append(logging.StreamHandler(sys.stderr))

    logging.basicConfig(
        level=getattr(logging, CONFIG.log_level.upper(), logging.INFO),
        format=log_format,
        datefmt=date_format,
        handlers=handlers,
    )


def print_banner() -> None:
    """Print application banner to stderr (not stdout)."""
    print("\n" + "=" * 60, file=sys.stderr)
    print("  ReBin  |  Local Waste Object Detection", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    print(f"  Model: {CONFIG.model_path.name}", file=sys.stderr)
    print(f"  Camera: Index {CONFIG.camera_index}", file=sys.stderr)
    print(f"  Confidence Threshold: {CONFIG.confidence_threshold}", file=sys.stderr)
    print(f"  Output: {CONFIG.project_root}", file=sys.stderr)
    print("-" * 60, file=sys.stderr)
    print("  Controls:", file=sys.stderr)
    print("    SPACE  - Capture photo & run detection", file=sys.stderr)
    print("    Q/ESC  - Quit application", file=sys.stderr)
    print("    C      - Cancel current capture", file=sys.stderr)
    print("=" * 60 + "\n", file=sys.stderr)


def _build_detection_summary(detections: list[Detection]) -> dict[str, int]:
    """Group detections by label and count them."""
    return dict(Counter(d.label for d in detections))


def run_cli_mode(image_path: Path) -> int:
    """Process a single image file via CLI. Print JSON to stdout, logs to stderr.

    Returns 0 on success, non-zero on failure.
    """
    logger = logging.getLogger(__name__)

    if not image_path.exists():
        error_output = {
            "schema_version": "1.0",
            "status": "error",
            "error": f"Image not found: {image_path}",
        }
        print(json.dumps(error_output))
        logger.error(f"Image not found: {image_path}")
        return 1

    if not CONFIG.model_path.exists():
        error_output = {
            "schema_version": "1.0",
            "status": "error",
            "error": f"Model file not found: {CONFIG.model_path}",
        }
        print(json.dumps(error_output))
        logger.error(f"Model file not found: {CONFIG.model_path}")
        return 1

    try:
        YOLODetector.load_model()
    except Exception as e:
        error_output = {
            "schema_version": "1.0",
            "status": "error",
            "error": f"Failed to load YOLO model: {e}",
        }
        print(json.dumps(error_output))
        logger.exception("Failed to load YOLO model")
        return 1

    scan_id = _generate_scan_id()
    created_at = _utc_now_iso()

    logger.info(f"Starting CLI scan {scan_id} for image: {image_path}")

    detection_result = YOLODetector.detect(image_path)

    if detection_result.error:
        error_output = {
            "schema_version": "1.0",
            "status": "error",
            "scan_id": scan_id,
            "error": detection_result.error,
        }
        print(json.dumps(error_output))
        logger.error(f"Scan {scan_id}: Detection failed - {detection_result.error}")
        return 1

    detections = detection_result.detections
    summary_counts = _build_detection_summary(detections)

    output = {
        "schema_version": "1.0",
        "status": "completed",
        "scan_id": scan_id,
        "created_at": created_at,
        "completed_at": _utc_now_iso(),
        "image": {
            "path": str(image_path),
            "width": detection_result.image_width,
            "height": detection_result.image_height,
        },
        "model": {
            "name": CONFIG.model_name,
            "weights_path": CONFIG.model_weights_path,
            "task": "object_detection",
            "confidence_threshold": CONFIG.confidence_threshold,
            "inference_image_size": CONFIG.inference_image_size,
            "test_time_augmentation": CONFIG.test_time_augmentation,
            "tiled_inference": CONFIG.tiled_inference,
        },
        "detections": [
            {
                "class_id": det.class_id,
                "label": det.label,
                "confidence": det.confidence,
                "bounding_box": {
                    "x1": det.x1,
                    "y1": det.y1,
                    "x2": det.x2,
                    "y2": det.y2,
                },
            }
            for det in detections
        ],
        "summary": {
            "total_detections": len(detections),
            "unique_object_classes": sorted(summary_counts.keys()),
            "counts_by_label": summary_counts,
        },
        "errors": [],
    }

    print(json.dumps(output))
    logger.info(
        f"Scan {scan_id} completed: {len(detections)} detections, "
        f"counts_by_label={summary_counts}"
    )
    return 0


def run_webcam_mode() -> None:
    """Main detection loop: capture -> detect -> save -> repeat."""
    logger = logging.getLogger(__name__)

    try:
        YOLODetector.load_model()
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        print(f"\nERROR: Failed to load YOLO model: {e}", file=sys.stderr)
        print("Check that models/yolo26n.pt exists and is valid.", file=sys.stderr)
        return

    while True:
        scan_id = _generate_scan_id()
        created_at = _utc_now_iso()

        logger.info(f"Starting webcam scan {scan_id}")

        capture_result = capture_single_image(scan_id)

        if capture_result.error:
            if capture_result.error in ("User quit", "User cancelled"):
                logger.info(f"Scan {scan_id}: {capture_result.error}")
                if capture_result.error == "User quit":
                    break
                continue
            else:
                logger.error(f"Scan {scan_id}: Capture failed - {capture_result.error}")
                print(f"\nCapture error: {capture_result.error}", file=sys.stderr)
                continue

        print(f"\nCaptured image: {capture_result.image_path}", file=sys.stderr)
        print(f"Resolution: {capture_result.width}x{capture_result.height}", file=sys.stderr)
        print("Running detection...", file=sys.stderr)

        detection_result = YOLODetector.detect(capture_result.image_path)

        if detection_result.error:
            logger.error(f"Scan {scan_id}: Detection failed - {detection_result.error}")
            print(f"\nDetection error: {detection_result.error}", file=sys.stderr)

            write_failure_record(
                scan_id=scan_id,
                created_at=created_at,
                image_path=capture_result.image_path,
                image_width=capture_result.width,
                image_height=capture_result.height,
                error=detection_result.error,
            )
            continue

        detections = detection_result.detections
        print(f"\nDetections: {len(detections)}", file=sys.stderr)

        for i, det in enumerate(detections, 1):
            print(
                f"  {i}. {det.label} (class {det.class_id}) - {det.confidence:.2%} "
                f"[{det.x1},{det.y1},{det.x2},{det.y2}]",
                file=sys.stderr,
            )

        annotated_path = None
        if CONFIG.save_annotated_previews and detections:
            dated_dir = (
                CONFIG.detection_previews_dir
                / capture_result.image_path.relative_to(CONFIG.captured_images_dir).parent
            )
            dated_dir.mkdir(parents=True, exist_ok=True)
            annotated_path = dated_dir / f"{scan_id}_annotated.jpg"

            if create_annotated_image(capture_result.image_path, detections, annotated_path):
                print(f"Annotated preview: {annotated_path}", file=sys.stderr)
            else:
                annotated_path = None

        json_path = write_scan_record(
            image_path=capture_result.image_path,
            image_width=capture_result.width,
            image_height=capture_result.height,
            detections=detections,
            annotated_image_path=annotated_path,
        )

        if json_path:
            print(f"Record saved: {json_path}", file=sys.stderr)
        else:
            print("WARNING: Failed to save JSON record", file=sys.stderr)

        logger.info(f"Scan {scan_id} completed: {len(detections)} detections")


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="rebin: Local waste object detection using YOLO."
    )
    parser.add_argument(
        "--image",
        type=str,
        default=None,
        help="Path to an image file to process (CLI mode). If omitted, runs webcam mode.",
    )
    args = parser.parse_args()

    setup_logging(to_stderr=True)
    logger = logging.getLogger(__name__)

    logger.info("Application starting")

    if args.image:
        image_path = Path(args.image).resolve()
        return run_cli_mode(image_path)

    print_banner()

    if not CONFIG.model_path.exists():
        logger.error(f"Model not found: {CONFIG.model_path}")
        print(f"\nERROR: Model file not found at {CONFIG.model_path}", file=sys.stderr)
        print("Please ensure models/yolo26n.pt exists.", file=sys.stderr)
        return 1

    try:
        run_webcam_mode()
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
        print("\nInterrupted. Goodbye!", file=sys.stderr)
    except Exception as e:
        logger.exception(f"Unexpected error: {e}")
        print(f"\nUnexpected error: {e}", file=sys.stderr)
        return 1
    finally:
        logger.info("Application shutting down")

    return 0


if __name__ == "__main__":
    sys.exit(main())

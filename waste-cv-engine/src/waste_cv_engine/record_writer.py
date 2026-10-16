"""JSON record writer module for waste-cv-engine."""

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import List, Optional

from waste_cv_engine.config import CONFIG
from waste_cv_engine.detector import Detection
from waste_cv_engine.integrity import calculate_sha256, secure_write_text


logger = logging.getLogger(__name__)


@dataclass
class CaptureInfo:
    """Image capture metadata."""

    source: str
    image_path: str
    format: str
    width: int
    height: int
    sha256: str


@dataclass
class ModelInfo:
    """Model metadata."""

    name: str
    weights_path: str
    task: str
    confidence_threshold: float


@dataclass
class BoundingBox:
    """Bounding box coordinates."""

    x1: int
    y1: int
    x2: int
    y2: int


@dataclass
class DetectionRecord:
    """Single detection in JSON record."""

    class_id: int
    label: str
    confidence: float
    bounding_box: BoundingBox


@dataclass
class SummaryInfo:
    """Detection summary."""

    total_detections: int
    unique_object_classes: List[str]


@dataclass
class ArtifactsInfo:
    """Output artifact paths."""

    original_image: str
    json_record: str
    annotated_image: str


@dataclass
class ScanRecord:
    """Complete scan record for JSON serialization."""

    schema_version: str
    scan_id: str
    created_at: str
    completed_at: str
    status: str
    capture: CaptureInfo
    model: ModelInfo
    detections: List[DetectionRecord]
    summary: SummaryInfo
    artifacts: ArtifactsInfo
    errors: List[str]


def _utc_now_iso() -> str:
    """Get current UTC time in ISO 8601 format with Z suffix."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _generate_scan_id() -> str:
    """Generate a UUID v4 scan identifier."""
    return str(uuid.uuid4())


def _create_dated_directory(base_dir: Path) -> Path:
    """Create a date-based subdirectory (YYYY/MM/DD)."""
    now = datetime.now(timezone.utc)
    dated_dir = base_dir / now.strftime("%Y") / now.strftime("%m") / now.strftime("%d")
    dated_dir.mkdir(parents=True, exist_ok=True)
    return dated_dir


def _get_relative_path(file_path: Path, base_dir: Path) -> str:
    """Get relative path from base directory."""
    try:
        return str(file_path.relative_to(base_dir))
    except ValueError:
        return str(file_path)


def write_scan_record(
    image_path: Path,
    image_width: int,
    image_height: int,
    detections: List[Detection],
    annotated_image_path: Optional[Path] = None,
    inference_error: Optional[str] = None,
) -> Optional[Path]:
    """
    Write a complete scan record to JSON file.

    Args:
        image_path: Path to the captured image.
        image_width: Width of the captured image.
        image_height: Height of the captured image.
        detections: List of detections from YOLO.
        annotated_image_path: Path to annotated image (if saved).
        inference_error: Error message if inference failed.

    Returns:
        Path to the written JSON record, or None on failure.
    """
    scan_id = _generate_scan_id()
    created_at = _utc_now_iso()

    errors = []
    status = "completed"

    if inference_error:
        errors.append(inference_error)
        status = "failed"

    try:
        image_sha256 = calculate_sha256(image_path)
    except Exception as e:
        error_msg = f"Failed to calculate image hash: {e}"
        logger.error(error_msg)
        errors.append(error_msg)
        image_sha256 = ""

    dated_dir = _create_dated_directory(CONFIG.scan_records_dir)
    json_path = dated_dir / f"{scan_id}.json"

    if json_path.exists():
        error_msg = f"JSON record already exists (collision): {json_path}"
        logger.error(error_msg)
        errors.append(error_msg)
        return None

    if annotated_image_path and annotated_image_path.exists():
        annotated_rel = _get_relative_path(annotated_image_path, CONFIG.project_root)
    else:
        annotated_rel = ""

    capture_rel = _get_relative_path(image_path, CONFIG.project_root)
    json_rel = _get_relative_path(json_path, CONFIG.project_root)

    detection_records = []
    for det in detections:
        detection_records.append(DetectionRecord(
            class_id=det.class_id,
            label=det.label,
            confidence=det.confidence,
            bounding_box=BoundingBox(x1=det.x1, y1=det.y1, x2=det.x2, y2=det.y2),
        ))

    unique_classes = sorted(list(set(d.label for d in detections)))

    record = ScanRecord(
        schema_version="1.0",
        scan_id=scan_id,
        created_at=created_at,
        completed_at=_utc_now_iso(),
        status=status,
        capture=CaptureInfo(
            source="webcam",
            image_path=capture_rel,
            format="JPEG",
            width=image_width,
            height=image_height,
            sha256=image_sha256,
        ),
        model=ModelInfo(
            name=CONFIG.model_name,
            weights_path=CONFIG.model_weights_path,
            task="object_detection",
            confidence_threshold=CONFIG.confidence_threshold,
        ),
        detections=detection_records,
        summary=SummaryInfo(
            total_detections=len(detections),
            unique_object_classes=unique_classes,
        ),
        artifacts=ArtifactsInfo(
            original_image=capture_rel,
            json_record=json_rel,
            annotated_image=annotated_rel,
        ),
        errors=errors,
    )

    try:
        json_text = json.dumps(asdict(record), indent=2, ensure_ascii=False)
        success = secure_write_text(json_path, json_text)
        if success:
            logger.info(f"Scan record written to {json_path}")
            return json_path
        else:
            logger.error(f"Failed to write scan record to {json_path}")
            return None

    except Exception as e:
        logger.exception(f"Failed to serialize scan record: {e}")
        return None


def write_failure_record(
    scan_id: str,
    created_at: str,
    image_path: Optional[Path],
    image_width: int,
    image_height: int,
    error: str,
) -> Optional[Path]:
    """
    Write a failure record when inference fails after image capture.

    Args:
        scan_id: The scan ID.
        created_at: Creation timestamp.
        image_path: Path to captured image (if available).
        image_width: Image width.
        image_height: Image height.
        error: Error message.

    Returns:
        Path to the written JSON record, or None on failure.
    """
    errors = [error]
    status = "failed"

    try:
        image_sha256 = calculate_sha256(image_path) if image_path and image_path.exists() else ""
    except Exception:
        image_sha256 = ""

    dated_dir = _create_dated_directory(CONFIG.scan_records_dir)
    json_path = dated_dir / f"{scan_id}.json"

    if json_path.exists():
        logger.error(f"Failure record already exists: {json_path}")
        return None

    capture_rel = _get_relative_path(image_path, CONFIG.project_root) if image_path else ""
    json_rel = _get_relative_path(json_path, CONFIG.project_root)

    record = ScanRecord(
        schema_version="1.0",
        scan_id=scan_id,
        created_at=created_at,
        completed_at=_utc_now_iso(),
        status=status,
        capture=CaptureInfo(
            source="webcam",
            image_path=capture_rel,
            format="JPEG",
            width=image_width,
            height=image_height,
            sha256=image_sha256,
        ),
        model=ModelInfo(
            name=CONFIG.model_name,
            weights_path=CONFIG.model_weights_path,
            task="object_detection",
            confidence_threshold=CONFIG.confidence_threshold,
        ),
        detections=[],
        summary=SummaryInfo(
            total_detections=0,
            unique_object_classes=[],
        ),
        artifacts=ArtifactsInfo(
            original_image=capture_rel,
            json_record=json_rel,
            annotated_image="",
        ),
        errors=errors,
    )

    try:
        json_text = json.dumps(asdict(record), indent=2, ensure_ascii=False)
        success = secure_write_text(json_path, json_text)
        if success:
            logger.info(f"Failure record written to {json_path}")
            return json_path
        return None
    except Exception as e:
        logger.exception(f"Failed to write failure record: {e}")
        return None

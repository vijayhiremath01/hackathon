"""YOLO detection module for rebin."""

import logging
from pathlib import Path
from dataclasses import dataclass
from typing import List, Optional
import cv2
import numpy as np
from ultralytics import YOLO

from waste_cv_engine.config import CONFIG


logger = logging.getLogger(__name__)


@dataclass
class Detection:
    """Single detection result."""

    class_id: int
    label: str
    confidence: float
    x1: int
    y1: int
    x2: int
    y2: int


@dataclass
class DetectionResult:
    """Complete detection results for an image."""

    detections: List[Detection]
    image_width: int
    image_height: int
    error: Optional[str] = None


class YOLODetector:
    """YOLO model wrapper for object detection."""

    _model: Optional[YOLO] = None

    @classmethod
    def load_model(cls) -> YOLO:
        """Load YOLO model once per session."""
        if cls._model is None:
            model_path = CONFIG.model_path
            if not model_path.exists():
                error_msg = f"Model file not found: {model_path}"
                logger.error(error_msg)
                raise FileNotFoundError(error_msg)

            logger.info(f"Loading YOLO model from {model_path}")
            try:
                cls._model = YOLO(str(model_path))
                logger.info("YOLO model loaded successfully")
            except Exception as e:
                error_msg = f"Failed to load YOLO model: {e}"
                logger.exception(error_msg)
                raise

        return cls._model

    @classmethod
    def detect(cls, image_path: Path, confidence_threshold: Optional[float] = None) -> DetectionResult:
        """
        Run YOLO inference on a captured image.

        Args:
            image_path: Path to the captured image.
            confidence_threshold: Override default confidence threshold.

        Returns:
            DetectionResult with detections and image metadata.
        """
        if confidence_threshold is None:
            confidence_threshold = CONFIG.confidence_threshold

        if not image_path.exists():
            error_msg = f"Image not found: {image_path}"
            logger.error(error_msg)
            return DetectionResult(detections=[], image_width=0, image_height=0, error=error_msg)

        image = cv2.imread(str(image_path))
        if image is None:
            error_msg = f"Failed to read image: {image_path}"
            logger.error(error_msg)
            return DetectionResult(detections=[], image_width=0, image_height=0, error=error_msg)

        height, width = image.shape[:2]

        try:
            model = cls.load_model()
            # First inspect the whole image at a higher resolution. TTA is only
            # used on this pass so robustness improves without multiplying the
            # cost of every crop by the augmentation factor.
            full_results = model.predict(
                source=image,
                conf=confidence_threshold,
                imgsz=CONFIG.inference_image_size,
                augment=CONFIG.test_time_augmentation,
                max_det=300,
                verbose=False,
            )
            detections = _collect_detections(full_results, model.names, width, height)

            # Small items are easily lost when a whole 640x480 camera frame is
            # letterboxed into the model input. Overlapping crops effectively
            # zoom in while retaining their original-coordinate offsets.
            tiles = _make_overlapping_tiles(image) if CONFIG.tiled_inference else []
            if tiles:
                tile_results = model.predict(
                    source=[tile for tile, _, _ in tiles],
                    conf=confidence_threshold,
                    imgsz=CONFIG.inference_image_size,
                    augment=False,
                    max_det=300,
                    verbose=False,
                )
                for result, (_, offset_x, offset_y) in zip(tile_results, tiles):
                    detections.extend(
                        _collect_detections(
                            [result], model.names, width, height, offset_x, offset_y
                        )
                    )

            detections = _suppress_duplicates(
                detections, CONFIG.duplicate_iou_threshold
            )

            logger.info(
                "Detection complete: %s objects found (imgsz=%s, TTA=%s, tiles=%s)",
                len(detections),
                CONFIG.inference_image_size,
                CONFIG.test_time_augmentation,
                len(tiles),
            )
            return DetectionResult(
                detections=detections,
                image_width=width,
                image_height=height,
            )
        except Exception as e:
            error_msg = f"Inference failed: {e}"
            logger.exception(error_msg)
            return DetectionResult(
                detections=[],
                image_width=width,
                image_height=height,
                error=error_msg,
            )


def _make_overlapping_tiles(image: np.ndarray) -> list[tuple[np.ndarray, int, int]]:
    """Return overlapping image crops with consistent sizes and source offsets."""
    height, width = image.shape[:2]
    if min(width, height) < 320:
        return []

    tile_width = min(width, max(320, int(width * CONFIG.tile_fraction)))
    tile_height = min(height, max(320, int(height * CONFIG.tile_fraction)))
    if tile_width == width and tile_height == height:
        return []

    def starts(length: int, tile_length: int) -> list[int]:
        if tile_length >= length:
            return [0]
        stride = max(1, int(tile_length * 0.72))
        values = list(range(0, length - tile_length + 1, stride))
        final = length - tile_length
        if values[-1] != final:
            values.append(final)
        return values

    tiles = []
    for y in starts(height, tile_height):
        for x in starts(width, tile_width):
            tiles.append((image[y:y + tile_height, x:x + tile_width], x, y))
    return tiles


def _collect_detections(
    results: list,
    names: dict | list,
    image_width: int,
    image_height: int,
    offset_x: int = 0,
    offset_y: int = 0,
) -> list[Detection]:
    """Convert Ultralytics results to validated coordinates in the source image."""
    detections = []
    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue
        for box in boxes:
            cls_id = int(box.cls[0].item())
            confidence = float(box.conf[0].item())
            x1f, y1f, x2f, y2f = box.xyxy[0].cpu().tolist()
            x1 = max(0, min(image_width, round(x1f + offset_x)))
            y1 = max(0, min(image_height, round(y1f + offset_y)))
            x2 = max(0, min(image_width, round(x2f + offset_x)))
            y2 = max(0, min(image_height, round(y2f + offset_y)))
            if not _validate_bbox(x1, y1, x2, y2, image_width, image_height):
                logger.debug("Ignoring invalid bbox: (%s,%s,%s,%s)", x1, y1, x2, y2)
                continue
            label = names.get(cls_id, f"class_{cls_id}") if isinstance(names, dict) else (
                names[cls_id] if cls_id < len(names) else f"class_{cls_id}"
            )
            detections.append(Detection(cls_id, str(label), confidence, x1, y1, x2, y2))
    return detections


def _suppress_duplicates(detections: list[Detection], iou_threshold: float) -> list[Detection]:
    """Merge overlapping same-class boxes from the full-frame and tile passes."""
    kept: list[Detection] = []
    for candidate in sorted(detections, key=lambda detection: detection.confidence, reverse=True):
        if any(
            existing.class_id == candidate.class_id
            and (
                _bbox_iou(existing, candidate) >= iou_threshold
                or _overlap_over_smaller_box(existing, candidate) >= 0.75
            )
            for existing in kept
        ):
            continue
        kept.append(candidate)
    return kept


def _bbox_iou(first: Detection, second: Detection) -> float:
    intersection_width = max(0, min(first.x2, second.x2) - max(first.x1, second.x1))
    intersection_height = max(0, min(first.y2, second.y2) - max(first.y1, second.y1))
    intersection = intersection_width * intersection_height
    if not intersection:
        return 0.0
    first_area = (first.x2 - first.x1) * (first.y2 - first.y1)
    second_area = (second.x2 - second.x1) * (second.y2 - second.y1)
    return intersection / max(1, first_area + second_area - intersection)


def _overlap_over_smaller_box(first: Detection, second: Detection) -> float:
    """Measure how much of the smaller box is covered by the larger one."""
    intersection_width = max(0, min(first.x2, second.x2) - max(first.x1, second.x1))
    intersection_height = max(0, min(first.y2, second.y2) - max(first.y1, second.y1))
    intersection = intersection_width * intersection_height
    first_area = (first.x2 - first.x1) * (first.y2 - first.y1)
    second_area = (second.x2 - second.x1) * (second.y2 - second.y1)
    return intersection / max(1, min(first_area, second_area))

def _validate_bbox(x1: int, y1: int, x2: int, y2: int, img_width: int, img_height: int) -> bool:
    """Validate bounding box coordinates."""
    if x1 < 0 or y1 < 0 or x2 < 0 or y2 < 0:
        return False
    if x1 >= img_width or y1 >= img_height:
        return False
    if x2 > img_width or y2 > img_height:
        return False
    if x2 <= x1 or y2 <= y1:
        return False
    return True


def create_annotated_image(image_path: Path, detections: List[Detection], output_path: Path) -> bool:
    """
    Create annotated image with bounding boxes and labels.

    Args:
        image_path: Path to original image.
        detections: List of detections to draw.
        output_path: Path to save annotated image.

    Returns:
        True if successful, False otherwise.
    """
    try:
        image = cv2.imread(str(image_path))
        if image is None:
            logger.error(f"Failed to read image for annotation: {image_path}")
            return False

        for det in detections:
            cv2.rectangle(image, (det.x1, det.y1), (det.x2, det.y2), (0, 255, 0), 2)

            label_text = f"{det.label} {det.confidence:.2f}"
            (text_w, text_h), _ = cv2.getTextSize(label_text, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
            cv2.rectangle(image, (det.x1, det.y1 - text_h - 8), (det.x1 + text_w, det.y1), (0, 255, 0), -1)
            cv2.putText(image, label_text, (det.x1, det.y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        success = cv2.imwrite(str(output_path), image, [cv2.IMWRITE_JPEG_QUALITY, CONFIG.jpeg_quality])
        if success:
            logger.info(f"Annotated image saved to {output_path}")
        else:
            logger.error(f"Failed to save annotated image to {output_path}")
        return success

    except Exception as e:
        logger.exception(f"Failed to create annotated image: {e}")
        return False

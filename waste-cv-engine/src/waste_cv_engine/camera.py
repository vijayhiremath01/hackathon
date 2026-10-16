"""Camera capture module for rebin."""

import cv2
import logging
import time
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

from waste_cv_engine.config import CONFIG


logger = logging.getLogger(__name__)


@dataclass
class CaptureResult:
    """Result of a camera capture operation."""

    image_path: Optional[Path] = None
    image_data: Optional["cv2.Mat"] = None
    width: int = 0
    height: int = 0
    error: Optional[str] = None


def _create_dated_directory(base_dir: Path) -> Path:
    """Create a date-based subdirectory (YYYY/MM/DD)."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    dated_dir = base_dir / now.strftime("%Y") / now.strftime("%m") / now.strftime("%d")
    dated_dir.mkdir(parents=True, exist_ok=True)
    return dated_dir


def _generate_image_filename(dated_dir: Path, scan_id: str) -> Path:
    """Generate a unique image filename."""
    return dated_dir / f"{scan_id}.jpg"


def capture_single_image(scan_id: str) -> CaptureResult:
    """
    Open webcam, show preview, capture one image on SPACE key press.

    Args:
        scan_id: Unique identifier for this scan session.

    Returns:
        CaptureResult with image path and metadata, or error.
    """
    cap = None
    try:
        cap = cv2.VideoCapture(CONFIG.camera_index)
        if not cap.isOpened():
            error_msg = f"Cannot open camera at index {CONFIG.camera_index}"
            logger.error(error_msg)
            return CaptureResult(error=error_msg)

        logger.info(f"Camera opened successfully at index {CONFIG.camera_index}")

        dated_dir = _create_dated_directory(CONFIG.captured_images_dir)
        image_path = _generate_image_filename(dated_dir, scan_id)

        window_name = CONFIG.window_name
        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)

        instructions = "SPACE: Capture  |  Q/ESC: Quit  |  C: Cancel"
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.7
        color = (0, 255, 0)
        thickness = 2

        captured_frame = None

        while True:
            ret, frame = cap.read()
            if not ret:
                error_msg = "Failed to read frame from camera"
                logger.error(error_msg)
                return CaptureResult(error=error_msg)

            display_frame = frame.copy()
            cv2.putText(display_frame, instructions, (10, 30), font, font_scale, color, thickness, cv2.LINE_AA)

            cv2.imshow(window_name, display_frame)

            key = cv2.waitKey(1) & 0xFF

            if key == ord(' '):
                captured_frame = frame.copy()
                break
            elif key == ord('q') or key == 27:
                return CaptureResult(error="User quit")
            elif key == ord('c'):
                return CaptureResult(error="User cancelled")

        if captured_frame is None or captured_frame.size == 0:
            error_msg = "Captured image is empty"
            logger.error(error_msg)
            return CaptureResult(error=error_msg)

        height, width = captured_frame.shape[:2]
        if width == 0 or height == 0:
            error_msg = "Captured image has invalid dimensions"
            logger.error(error_msg)
            return CaptureResult(error=error_msg)

        success = cv2.imwrite(str(image_path), captured_frame, [cv2.IMWRITE_JPEG_QUALITY, CONFIG.jpeg_quality])
        if not success:
            error_msg = f"Failed to save image to {image_path}"
            logger.error(error_msg)
            return CaptureResult(error=error_msg)

        logger.info(f"Image saved to {image_path} ({width}x{height})")

        return CaptureResult(
            image_path=image_path,
            image_data=captured_frame,
            width=width,
            height=height,
        )

    except Exception as e:
        error_msg = f"Camera capture failed: {e}"
        logger.exception(error_msg)
        return CaptureResult(error=error_msg)

    finally:
        if cap is not None:
            cap.release()
        cv2.destroyAllWindows()


def release_camera(cap: Optional[cv2.VideoCapture]) -> None:
    """Safely release camera resources."""
    if cap is not None:
        cap.release()
    cv2.destroyAllWindows()
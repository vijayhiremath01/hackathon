"""Configuration settings for waste-cv-engine."""

import os
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class Config:
    """Application configuration with sensible defaults."""

    project_root: Path = field(default_factory=lambda: Path(__file__).parent.parent.parent)

    model_path: Path = field(default_factory=lambda: _model_path_from_env())

    camera_index: int = 0

    confidence_threshold: float = 0.25

    # Larger inputs retain more detail in small bottles, cups, and books.
    inference_image_size: int = field(default_factory=lambda: _int_env("WASTE_CV_IMAGE_SIZE", 960, minimum=320))

    # Test-time augmentation improves robustness on a single still image at extra cost.
    test_time_augmentation: bool = field(default_factory=lambda: _bool_env("WASTE_CV_TTA", True))

    # Overlapping crops make small objects occupy more of the model input.
    tiled_inference: bool = field(default_factory=lambda: _bool_env("WASTE_CV_TILED_INFERENCE", True))

    tile_fraction: float = field(default_factory=lambda: _float_env("WASTE_CV_TILE_FRACTION", 0.72, minimum=0.5, maximum=0.9))

    duplicate_iou_threshold: float = 0.45

    captured_images_dir: Path = field(default_factory=lambda: Path(__file__).parent.parent.parent / "captured_images")

    scan_records_dir: Path = field(default_factory=lambda: Path(__file__).parent.parent.parent / "scan_records")

    detection_previews_dir: Path = field(default_factory=lambda: Path(__file__).parent.parent.parent / "detection_previews")

    logs_dir: Path = field(default_factory=lambda: Path(__file__).parent.parent.parent / "logs")

    jpeg_quality: int = 95

    save_annotated_previews: bool = True

    log_level: str = "INFO"

    window_name: str = "Waste CV Engine - Press SPACE to capture, Q/ESC to quit"

    def __post_init__(self):
        """Ensure all paths are absolute."""
        self.project_root = self.project_root.resolve()
        self.model_path = self.model_path.resolve()
        self.captured_images_dir = self.captured_images_dir.resolve()
        self.scan_records_dir = self.scan_records_dir.resolve()
        self.detection_previews_dir = self.detection_previews_dir.resolve()
        self.logs_dir = self.logs_dir.resolve()

        for dir_path in [
            self.captured_images_dir,
            self.scan_records_dir,
            self.detection_previews_dir,
            self.logs_dir,
        ]:
            dir_path.mkdir(parents=True, exist_ok=True)

    @property
    def model_name(self) -> str:
        """Human-readable label derived from the configured checkpoint filename."""
        stem = self.model_path.stem.lower()
        scale_names = {"n": "Nano", "s": "Small", "m": "Medium", "l": "Large", "x": "Extra Large"}
        for scale, display in scale_names.items():
            if stem.endswith(scale) and stem.startswith("yolo"):
                family = stem[:-1].upper()
                return f"{family} {display}"
        return self.model_path.stem

    @property
    def model_weights_path(self) -> str:
        try:
            return str(self.model_path.relative_to(self.project_root))
        except ValueError:
            return self.model_path.name


def _model_path_from_env() -> Path:
    configured = os.getenv("WASTE_CV_MODEL_PATH")
    if not configured:
        return Path(__file__).parent.parent.parent / "models" / "yolo26n.pt"
    model_path = Path(configured).expanduser()
    if not model_path.is_absolute():
        model_path = Path(__file__).parent.parent.parent / model_path
    return model_path


def _int_env(name: str, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        return min(maximum, max(minimum, float(os.getenv(name, str(default)))))
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


CONFIG = Config()

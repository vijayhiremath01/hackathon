"""Image integrity and security module for waste-cv-engine."""

import hashlib
import logging
import os
from pathlib import Path
from dataclasses import dataclass

from waste_cv_engine.config import CONFIG


logger = logging.getLogger(__name__)


@dataclass
class IntegrityResult:
    """Result of integrity verification."""

    verified: bool
    expected_hash: str
    actual_hash: str
    error: str = ""


def calculate_sha256(file_path: Path) -> str:
    """
    Calculate SHA-256 hash of a file.

    Args:
        file_path: Path to the file.

    Returns:
        Hexadecimal SHA-256 hash string.

    Raises:
        FileNotFoundError: If file doesn't exist.
        IOError: If file cannot be read.
    """
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)

    return sha256.hexdigest()


def verify_integrity(file_path: Path, expected_hash: str) -> IntegrityResult:
    """
    Verify file integrity against expected SHA-256 hash.

    Args:
        file_path: Path to the file to verify.
        expected_hash: Expected SHA-256 hash (hex string).

    Returns:
        IntegrityResult with verification status.
    """
    try:
        actual_hash = calculate_sha256(file_path)
        verified = actual_hash.lower() == expected_hash.lower()

        if not verified:
            logger.warning(f"Integrity check failed for {file_path}: expected {expected_hash}, got {actual_hash}")
        else:
            logger.info(f"Integrity verified for {file_path}")

        return IntegrityResult(
            verified=verified,
            expected_hash=expected_hash,
            actual_hash=actual_hash,
        )

    except Exception as e:
        error_msg = f"Integrity verification error for {file_path}: {e}"
        logger.exception(error_msg)
        return IntegrityResult(
            verified=False,
            expected_hash=expected_hash,
            actual_hash="",
            error=error_msg,
        )


def secure_write(file_path: Path, data: bytes, mode: int = 0o600) -> bool:
    """
    Write data to file securely using atomic rename.

    Args:
        file_path: Destination path.
        data: Bytes to write.
        mode: File permissions (default 0o600 for privacy).

    Returns:
        True if successful, False otherwise.
    """
    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)

        if file_path.exists():
            logger.error(f"Refusing to overwrite existing file: {file_path}")
            return False

        temp_path = file_path.with_suffix(file_path.suffix + ".tmp")

        with open(temp_path, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())

        os.chmod(temp_path, mode)
        temp_path.rename(file_path)

        logger.debug(f"Securely wrote {len(data)} bytes to {file_path}")
        return True

    except Exception as e:
        logger.exception(f"Secure write failed for {file_path}: {e}")
        if temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass
        return False


def secure_write_text(file_path: Path, text: str, encoding: str = "utf-8", mode: int = 0o600) -> bool:
    """
    Write text to file securely using atomic rename.

    Args:
        file_path: Destination path.
        text: Text to write.
        encoding: Text encoding (default utf-8).
        mode: File permissions (default 0o600 for privacy).

    Returns:
        True if successful, False otherwise.
    """
    return secure_write(file_path, text.encode(encoding), mode)


def validate_output_path(path: Path, base_dir: Path) -> bool:
    """
    Validate that a path is within the allowed base directory.

    Args:
        path: Path to validate.
        base_dir: Allowed base directory.

    Returns:
        True if path is within base_dir, False otherwise.
    """
    try:
        resolved_path = path.resolve()
        resolved_base = base_dir.resolve()
        return resolved_path.is_relative_to(resolved_base)
    except Exception:
        return False


def cleanup_temp_files(directory: Path, pattern: str = "*.tmp") -> int:
    """
    Clean up temporary files in a directory.

    Args:
        directory: Directory to clean.
        pattern: Glob pattern for temp files.

    Returns:
        Number of files removed.
    """
    count = 0
    try:
        for temp_file in directory.glob(pattern):
            if temp_file.is_file():
                temp_file.unlink()
                count += 1
                logger.debug(f"Cleaned up temp file: {temp_file}")
    except Exception as e:
        logger.warning(f"Temp file cleanup failed: {e}")
    return count
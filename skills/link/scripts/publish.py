#!/usr/bin/env python3
"""Publish a locked HTML folder as a Bench Page. Never prints secrets."""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit
from uuid import uuid4

SELF = Path(__file__).resolve()
COWORK_CONFIG = Path.home() / ".claude" / "config" / "bench-cowork.json"
DEFAULT_BASE = "https://benchagi.com"

# Mirrors apps/web/src/lib/bench-share/types.ts. Checked locally so a folder that
# cannot fit is refused BEFORE a live public share exists.
MAX_EXPIRATION_DAYS = 365
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_BYTES = 250 * 1024 * 1024
MAX_TITLE_CHARS = 200

SKIP_DIR_NAMES = {".git", "node_modules", ".next", ".ssh", ".aws"}
SKIP_DIR_NAMES_LOWER = {name.lower() for name in SKIP_DIR_NAMES}
SKIP_FILE_PREFIXES = ("verify-",)
SKIP_FILE_NAMES = {".env", ".npmrc"}
ALLOWED_EXT = {
    ".css",
    ".gif",
    ".html",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".mjs",
    ".png",
    ".svg",
    ".txt",
    ".webp",
    ".woff",
    ".woff2",
}
MIME_BY_EXT = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


class LinkError(Exception):
    pass


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never forward credentials or upload bytes to a redirect target."""

    def redirect_request(self, *args, **kwargs):
        return None


NO_REDIRECT_OPENER = urllib.request.build_opener(NoRedirectHandler)


def die(message: str, code: int = 2) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def is_secret_name(name: str) -> bool:
    lower = name.lower()
    if lower in SKIP_FILE_NAMES or lower.startswith(".env"):
        return True
    if any(lower.endswith(s) for s in (".pem", ".p8", ".key", ".p12", ".pfx", ".jks", ".keystore")):
        return True
    return lower in {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json", "service-account.json"} or (
        lower.startswith("firebase-adminsdk-") and lower.endswith(".json")
    )


def skip_reason(path: Path) -> str | None:
    """Why this file is not published, or None to publish it."""
    name = path.name
    if is_secret_name(name):
        return "secret-looking"
    if name.lower().startswith(SKIP_FILE_PREFIXES):
        return "verify script"
    if path.suffix.lower() in {".md", ".py"}:
        return "not a page asset"
    if path.suffix.lower() not in ALLOWED_EXT:
        return "unsupported type"
    return None


def check_size(relative: str, size: int, running_total: int) -> int:
    if size <= 0:
        raise LinkError(f"link: {relative} is empty; empty files cannot be published.")
    if size > MAX_FILE_BYTES:
        raise LinkError(
            f"link: {relative} is {size / 1048576:.1f} MB; the per-file cap is "
            f"{MAX_FILE_BYTES // 1048576} MB."
        )
    total = running_total + size
    if total > MAX_TOTAL_BYTES:
        raise LinkError(
            f"link: folder exceeds the {MAX_TOTAL_BYTES // 1048576} MB total cap."
        )
    return total


def validate_relative_path(value: str) -> None:
    has_control_character = any(
        ord(character) <= 0x1f or ord(character) == 0x7f
        for character in value
    )
    if not value or has_control_character:
        raise LinkError("link: file path is empty or contains a control character.")
    if value.startswith("/") or value.startswith("\\") or any(
        value.startswith(prefix) for prefix in ("../", "..\\")
    ) or (len(value) >= 3 and value[1] == ":" and value[2] in "/\\"):
        raise LinkError(f"link: file path must be relative: {value}")
    if "\\" in value:
        raise LinkError(f"link: file path must use forward slashes: {value}")
    if any(segment in {"", ".", ".."} for segment in value.split("/")):
        raise LinkError(f"link: file path contains an unsafe segment: {value}")


def should_skip_directory(name: str) -> bool:
    return name.lower() in SKIP_DIR_NAMES_LOWER or is_secret_name(name)


def copy_regular_file(source: Path, target: Path) -> None:
    """Copy by descriptor so a file cannot become a symlink after preflight."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(source, flags)
    except OSError as error:
        raise LinkError(f"link: refusing to stage non-regular file: {source}") from error

    try:
        source_stat = os.fstat(descriptor)
        if not stat.S_ISREG(source_stat.st_mode):
            raise LinkError(f"link: refusing to stage non-regular file: {source}")
        with os.fdopen(descriptor, "rb") as source_handle:
            descriptor = -1
            with target.open("wb") as target_handle:
                shutil.copyfileobj(source_handle, target_handle, length=1024 * 1024)
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def stage(source: Path, dest: Path, dropped: list[str] | None = None) -> list[str]:
    """Copy the publishable files into dest; append each drop to `dropped`."""
    dest.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []
    total = 0
    if source.is_file():
        if source.suffix.lower() != ".html":
            raise LinkError(f"link: not an HTML file: {source}")
        if is_secret_name(source.name):
            raise LinkError(f"link: refusing secret-looking file: {source.name}")
        check_size(source.name, source.stat().st_size, 0)
        target = dest / "index.html"
        copy_regular_file(source, target)
        check_size("index.html", target.stat().st_size, 0)
        return ["index.html"]

    if not source.is_dir():
        raise LinkError(f"link: not a file or folder: {source}")
    if should_skip_directory(source.name):
        raise LinkError(f"link: refusing protected directory: {source}")

    for dirpath, dirnames, filenames in os.walk(source):
        dirnames[:] = [d for d in dirnames if not should_skip_directory(d)]
        here = Path(dirpath)
        for name in filenames:
            src_file = here / name
            rel_name = src_file.relative_to(source).as_posix()
            if src_file.is_symlink():
                if dropped is not None:
                    dropped.append(f"{rel_name} (symlink)")
                continue
            reason = skip_reason(src_file)
            if reason is not None:
                if dropped is not None:
                    dropped.append(f"{rel_name} ({reason})")
                continue
            rel = rel_name
            validate_relative_path(rel)
            check_size(rel, src_file.stat().st_size, total)
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            copy_regular_file(src_file, target)
            total = check_size(rel, target.stat().st_size, total)
            copied.append(rel)

    if "index.html" not in copied:
        raise LinkError("link: folder must contain index.html (browser-only state is not included).")
    return copied


def clean_title(value: str) -> str:
    title = " ".join(value.split())
    if not title:
        raise LinkError("link: title is empty; pass --title.")
    bounded: list[str] = []
    units = 0
    for character in title:
        character_units = 2 if ord(character) > 0xffff else 1
        if units + character_units > MAX_TITLE_CHARS:
            break
        bounded.append(character)
        units += character_units
    return "".join(bounded)


def parse_expires(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        days = int(value)
    except ValueError:
        raise LinkError(
            f"link: --expires-in-days must be a whole number from 1 to {MAX_EXPIRATION_DAYS}."
        ) from None
    if not 1 <= days <= MAX_EXPIRATION_DAYS:
        raise LinkError(
            f"link: --expires-in-days must be from 1 to {MAX_EXPIRATION_DAYS} (got {days})."
        )
    return days


def load_cowork_config() -> dict:
    if not COWORK_CONFIG.is_file():
        return {}
    try:
        data = json.loads(COWORK_CONFIG.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def normalize_base_url(value: str) -> str:
    raw = value.strip()
    try:
        parsed = urlsplit(raw)
    except ValueError as error:
        raise LinkError(f"link: invalid Bench API base URL: {error}") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise LinkError("link: Bench API base URL must be an absolute http(s) URL.")
    if parsed.username or parsed.password:
        raise LinkError("link: Bench API base URL must not contain credentials.")
    if parsed.query or parsed.fragment:
        raise LinkError("link: Bench API base URL must not contain a query or fragment.")

    path = parsed.path.rstrip("/")
    for api_suffix in ("/api/v1", "/api"):
        if path == api_suffix:
            path = ""
            break
        if path.endswith(api_suffix):
            path = path[: -len(api_suffix)] or "/"
            break
    return urlunsplit((parsed.scheme, parsed.netloc, path.rstrip("/"), "", ""))


def base_url() -> str:
    config = load_cowork_config()
    configured = config.get("bench_api_base")
    raw = (
        os.environ.get("BENCH_API_BASE_URL")
        or os.environ.get("BENCH_API_BASE")
        or (configured if isinstance(configured, str) else None)
        or DEFAULT_BASE
    )
    return normalize_base_url(raw)


def load_cowork_token() -> str | None:
    data = load_cowork_config()
    token = data.get("bench_cowork_token") or data.get("token")
    return token.strip() if isinstance(token, str) and token.strip() else None


def auth_headers() -> dict[str, str]:
    api_key = (os.environ.get("BENCH_API_KEY") or "").strip()
    if api_key:
        return {"X-API-Key": api_key}
    bearer = (
        (os.environ.get("BENCH_AUTH_TOKEN") or "").strip()
        or (os.environ.get("BENCH_COWORK_TOKEN") or "").strip()
        or load_cowork_token()
        or ""
    )
    if bearer:
        return {"Authorization": f"Bearer {bearer}"}
    raise LinkError(
        "link: run /bench-login, or set BENCH_API_KEY / BENCH_AUTH_TOKEN / BENCH_COWORK_TOKEN."
    )


def request_json(method: str, url: str, headers: dict[str, str], payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload).encode()
    req_headers = dict(headers)
    if body is not None:
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=req_headers, method=method)
    try:
        with NO_REDIRECT_OPENER.open(req) as response:
            raw = response.read().decode()
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        try:
            parsed = json.loads(detail)
            message = parsed.get("error") if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            message = None
        raise LinkError(message or f"Bench API returned {err.code}.") from err
    except urllib.error.URLError as error:
        raise LinkError("Bench API request failed before receiving a response.") from error
    except UnicodeDecodeError as error:
        raise LinkError("Bench API returned an unreadable response.") from error
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise LinkError("Bench API returned invalid JSON.") from error
    if not isinstance(parsed, dict):
        raise LinkError("Bench API returned a non-object JSON body.")
    return parsed


def content_type_for(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in MIME_BY_EXT:
        return MIME_BY_EXT[ext]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def upload_file(url: str, headers: dict[str, str], relative: str, path: Path) -> None:
    boundary = f"----BenchLink{uuid4().hex}"
    filename = "".join(
        character if 0x20 <= ord(character) <= 0x7e and character not in {'"', "\\"} else "_"
        for character in path.name
    ) or "file"
    try:
        file_bytes = path.read_bytes()
    except OSError as error:
        raise LinkError(f"Failed to read {relative} before upload.") from error
    ctype = content_type_for(path)
    preamble = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="path"\r\n\r\n'
        f"{relative}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode()
    closing = f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        url,
        data=preamble + file_bytes + closing,
        headers={**headers, "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with NO_REDIRECT_OPENER.open(req) as response:
            response.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        try:
            parsed = json.loads(detail)
            message = parsed.get("error") if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            message = None
        raise LinkError(f"Failed to upload {relative}: {message or f'Bench API returned {err.code}.'}") from err
    except urllib.error.URLError as error:
        raise LinkError(f"Failed to upload {relative}: Bench API request failed before receiving a response.") from error


def revoke(slug: str) -> None:
    headers = auth_headers()
    encoded_slug = quote(slug, safe="")
    request_json("POST", f"{base_url()}/api/bench-share/{encoded_slug}/revoke", headers, {})
    print(f"Revoked: {base_url()}/s/{encoded_slug}")


def publish(folder: Path, title: str | None, expires: str | None, dry_run: bool) -> None:
    days = parse_expires(expires)
    shown_title = clean_title(title or (folder.stem if folder.is_file() else folder.name))
    with tempfile.TemporaryDirectory(prefix="bench-link-") as tmp:
        staged = Path(tmp) / "page"
        dropped: list[str] = []
        files = stage(folder, staged, dropped)
        if dropped:
            # A dropped asset the page links to publishes as a broken URL, so
            # name every drop before the share exists rather than after.
            print(f"Not published ({len(dropped)}):", file=sys.stderr)
            for entry in dropped:
                print(f"  {entry}", file=sys.stderr)
        if dry_run:
            print(f"dry-run title: {shown_title}")
            print(f"dry-run files: {len(files)}")
            for rel in files:
                print(f"  {rel}")
            return
        headers = auth_headers()
        payload: dict = {"title": shown_title, "kind": "page"}
        if days is not None:
            payload["expiresInDays"] = days
        created = request_json("POST", f"{base_url()}/api/bench-share", headers, payload)
        slug = created.get("slug")
        if not isinstance(slug, str) or not slug:
            raise LinkError("Bench API create response did not include a slug.")
        encoded_slug = quote(slug, safe="")
        url = f"{base_url()}/s/{encoded_slug}"
        try:
            for rel in files:
                upload_file(
                    f"{base_url()}/api/bench-share/{encoded_slug}/files",
                    headers,
                    rel,
                    staged / rel,
                )
        except LinkError:
            print(f"Publish stopped after creating {url}.", file=sys.stderr)
            print(f"Revoke: python3 {SELF} --revoke {slug}", file=sys.stderr)
            raise
        print(f"Published: {url}")
        print(f"Revoke: python3 {SELF} --revoke {slug}")


def selftest() -> None:
    with tempfile.TemporaryDirectory(prefix="bench-link-selftest-") as tmp:
        root = Path(tmp)
        empty = root / "empty"
        empty.mkdir()
        try:
            stage(empty, root / "staged-empty")
        except LinkError:
            pass
        else:
            die("selftest: empty folder should fail")

        html = root / "page.html"
        html.write_text("<!doctype html><title>ok</title>", encoding="utf-8")
        staged_file = root / "from-file"
        assert stage(html, staged_file) == ["index.html"]

        folder = root / "board"
        folder.mkdir()
        (folder / "index.html").write_text("<!doctype html><h1>board</h1>", encoding="utf-8")
        (folder / "README.md").write_text("# no", encoding="utf-8")
        (folder / "verify-model.mjs").write_text("throw new Error('no')", encoding="utf-8")
        (folder / "style.css").write_text("body{color:#000}", encoding="utf-8")
        (folder / "app.js.map").write_text('{"sourcesContent":["secret"]}', encoding="utf-8")
        (folder / ".env").write_text("BENCH_API_KEY=nope", encoding="utf-8")
        (folder / "server.key").write_text("-----BEGIN PRIVATE KEY-----", encoding="utf-8")
        staged_dir = root / "from-dir"
        drops: list[str] = []
        files = stage(folder, staged_dir, drops)
        assert set(files) == {"index.html", "style.css"}, files
        for name in ("README.md", "verify-model.mjs", "app.js.map", ".env", "server.key"):
            assert not (staged_dir / name).exists(), name
        # Every drop is named, so a page that links a dropped asset is not a
        # silent surprise after the URL is already live.
        assert {entry.split(" (")[0] for entry in drops} == {
            "README.md",
            "verify-model.mjs",
            "app.js.map",
            ".env",
            "server.key",
        }, drops
        assert any(entry.endswith("(secret-looking)") for entry in drops), drops

        # Oversized files are refused while staging, before any share exists.
        big = root / "big"
        big.mkdir()
        (big / "index.html").write_text("<!doctype html>", encoding="utf-8")
        (big / "huge.png").write_bytes(b"\0" * (MAX_FILE_BYTES + 1))
        try:
            stage(big, root / "from-big")
        except LinkError:
            pass
        else:
            die("selftest: oversized file should fail")

        assert parse_expires(None) is None
        assert parse_expires("30") == 30
        for bad in ("0", "abc", str(MAX_EXPIRATION_DAYS + 1), ""):
            try:
                parse_expires(bad)
            except LinkError:
                pass
            else:
                die(f"selftest: --expires-in-days {bad!r} should fail")

        assert clean_title("  a\n  b  ") == "a b"
        assert len(clean_title("x" * 500)) == MAX_TITLE_CHARS
        emoji_title = clean_title("😀" * MAX_TITLE_CHARS)
        assert len(emoji_title.encode("utf-16-le")) // 2 <= MAX_TITLE_CHARS
        assert len(emoji_title) == MAX_TITLE_CHARS // 2
        try:
            clean_title("   ")
        except LinkError:
            pass
        else:
            die("selftest: blank title should fail")

        empty_file = root / "empty.html"
        empty_file.touch()
        try:
            stage(empty_file, root / "from-empty-file")
        except LinkError:
            pass
        else:
            die("selftest: empty HTML file should fail")

        protected = root / ".SSH"
        protected.mkdir()
        (protected / "index.html").write_text("<!doctype html>", encoding="utf-8")
        try:
            stage(protected, root / "from-protected")
        except LinkError:
            pass
        else:
            die("selftest: protected root directory should fail")

        unsafe_path = root / "unsafe-path"
        unsafe_path.mkdir()
        (unsafe_path / "index.html").write_text("<!doctype html>", encoding="utf-8")
        (unsafe_path / "bad\nname.css").write_text("body{}", encoding="utf-8")
        try:
            stage(unsafe_path, root / "from-unsafe-path")
        except LinkError:
            pass
        else:
            die("selftest: unsafe filename should fail")

        linked = root / "linked"
        linked.mkdir()
        (linked / "index.html").write_text("<!doctype html>", encoding="utf-8")
        try:
            (linked / "escape.css").symlink_to(folder / ".env")
        except (OSError, NotImplementedError):
            pass
        else:
            link_drops: list[str] = []
            assert stage(linked, root / "from-link", link_drops) == ["index.html"]
            assert not (root / "from-link" / "escape.css").exists()
            assert link_drops == ["escape.css (symlink)"], link_drops

        assert normalize_base_url("https://staging.example/api/v1/") == "https://staging.example"
        assert normalize_base_url("https://staging.example/app/api") == "https://staging.example/app"

        dry_run_out = StringIO()
        with redirect_stdout(dry_run_out), redirect_stderr(StringIO()):
            publish(folder, title="Selftest", expires=None, dry_run=True)
        assert "dry-run files: 2" in dry_run_out.getvalue(), dry_run_out.getvalue()
    print("selftest ok")


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish a Bench Page at /s/{slug}.")
    parser.add_argument("source", nargs="?", help="HTML file or folder with index.html")
    parser.add_argument("--title")
    parser.add_argument("--expires-in-days")
    parser.add_argument("--revoke")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        selftest()
        return
    try:
        if args.revoke:
            if args.dry_run:
                print(f"dry-run revoke: {args.revoke}")
                return
            revoke(args.revoke)
            return
        if not args.source:
            die("Usage: publish.py <folder-or-html> [--title ...] [--expires-in-days 1-365]")
        source = Path(args.source).expanduser().resolve()
        if not source.exists():
            die(f"link: missing path: {source}")
        publish(source, args.title, args.expires_in_days, args.dry_run)
    except LinkError as err:
        die(str(err))


if __name__ == "__main__":
    main()

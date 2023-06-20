import logging
import hashlib
import os
from datetime import timezone

import enlighten

from ps2exe import IsoProcessorFactory
from ps2exe import BaseIsoProcessor
from ps2exe import get_iso_info

LOGGER = logging.getLogger(__name__)
PROGRESS_MANAGER = enlighten.get_manager()
BUFFER_SIZE = 1024 * 1024


def process_iso(iso_filename):
    info = get_iso_info(iso_filename, True)
    contents = get_iso_contents(iso_filename)
    metadata = get_image_metadata(iso_filename)

    return {"info": info, "contents": contents, "metadata": metadata}


def get_iso_contents(iso_filename):
    files = get_iso_files(iso_filename)
    tree = get_file_tree(files)

    return tree


def get_file_tree(files):
    files.sort(key=lambda file: file["name"])

    root = []
    directories = [{"name": "", "files": root}]

    for file in files:
        file = dict(file)
        is_dir = file["directory"]
        del file["directory"]

        while len(directories) > 1:
            if file["name"].startswith(directories[-1]["name"]):
                break
            directories.pop()

        if is_dir:
            dir = {
                "name": file["name"],
                "size": file["size"],
                "date": file["date"],
                "type": "dir",
                "files": [],
            }
            directories[-1]["files"].append(dir)
            directories.append(dir)
        else:
            current_dir = directories[-1]
            file["name"] = file["name"].replace(current_dir["name"] + "/", "", 1)
            directories[-1]["files"].append(file)

    return root


def get_iso_files(iso_filename):
    iso_path = iso_filename.encode("cp1252", errors="replace")
    basename = os.path.basename(iso_filename).encode("cp1252", errors="replace")
    LOGGER.info("Reading %s", iso_path.decode("cp1252"))

    fp = open(iso_filename, "rb")

    if not (iso_path_reader := IsoProcessorFactory.get_iso_path_reader(fp, basename)):
        LOGGER.exception(
            f"Could not read ISO, this might be an unsupported format, iso: %s",
            iso_filename,
        )
        return

    system = BaseIsoProcessor.get_system_type(iso_path_reader)
    LOGGER.info("System: %s", system)

    if not (iso_processor_class := IsoProcessorFactory.get_iso_processor_class(system)):
        LOGGER.exception(
            f"Could not read ISO, this might be an unsupported format, iso: %s",
            iso_filename,
        )
        return

    iso_processor = iso_processor_class(
        iso_path_reader, iso_filename, system, PROGRESS_MANAGER
    )
    path_reader = iso_processor.iso_path_reader

    files = []

    root = path_reader.get_root_dir()
    for file in path_reader.iso_iterator(root, recursive=True, include_dirs=True):
        file_date = path_reader.get_file_date(file)
        if file_date:
            file_date = file_date.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        md5_hash = ""
        sha1_hash = ""

        props = {
            "name": path_reader.get_file_path(file).lstrip("/"),
            "date": file_date,
            "size": str(path_reader.get_file_size(file)),
            "directory": file.is_dir(),
        }

        if not path_reader.is_directory(file):
            props["md5"] = path_reader.get_file_hash(file, hashlib.md5).hexdigest()
            props["sha1"] = path_reader.get_file_hash(file, hashlib.sha1).hexdigest()
            props["sha256"] = path_reader.get_file_hash(
                file, hashlib.sha256
            ).hexdigest()

        files.append(props)

    return files


def get_image_metadata(filename):
    file_hashes = hashes(filename)

    return {
        "size": os.path.getsize(filename),
        "md5": file_hashes["md5"],
        "sha1": file_hashes["sha1"],
        "sha256": file_hashes["sha256"],
    }


def hashes(filename):
    hashes = {}
    digests = {}

    for algorithm in ("md5", "sha1", "sha256"):
        hashes[algorithm] = getattr(hashlib, algorithm)()

    with open(filename, "rb") as file:
        while chunk := file.read(BUFFER_SIZE):
            for hash in hashes.values():
                hash.update(chunk)

    for algorithm, hash in hashes.items():
        digests[algorithm] = hash.hexdigest()

    return digests

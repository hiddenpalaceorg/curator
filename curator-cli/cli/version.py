from importlib import metadata
import pathlib


PACKAGE_VERSION = metadata.version("curator-cli")


def git_hash():
    with open(
        pathlib.Path(__file__).parent.parent.parent / ".git" / "refs" / "heads" / "main"
    ) as f:
        hash = f.read()
        return hash[:7]


def version_string():
    try:
        return f"{PACKAGE_VERSION}-{git_hash()}"
    except FileNotFoundError:
        return f"{PACKAGE_VERSION}-unknown"
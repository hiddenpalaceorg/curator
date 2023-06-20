import argparse

from cli.iso import process_iso


def main():
    args = parse_args()

    format = get_formatter(args)

    for filename in args.file:
        info = process_iso(filename)
        print(format(info))


def get_formatter(args):
    if args.format == "xml":
        from cli.formats.xml import format

        return format
    elif args.format == "json":
        raise NotImplementedError("JSON is not implemented yet, sorry")
    else:
        raise Exception("Unsupported format")


def parse_args():
    parser = argparse.ArgumentParser(description="Description")

    parser.add_argument("file", nargs="+", help="files to process")
    parser.add_argument("--format", "-f", choices=["json", "xml"], default="xml")

    return parser.parse_args()

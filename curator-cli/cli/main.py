import argparse

from cli.iso import process_iso


def main():
    args = parse_args()

    format = get_formatter(args)

    if args.date_format == "iso8601":
        date_format = "%Y-%m-%dT%H:%M:%S"
    else:
        date_format = "%Y-%m-%d %H:%M:%S"

    for filename in args.file:
        info = process_iso(filename, date_format, args.no_checksums)
        print(format(info, date_format))


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
    parser.add_argument(
        "--date-format", choices=["default", "iso8601"], default="default"
    )
    parser.add_argument("--no-checksums", action="store_true")

    return parser.parse_args()

if __name__ == '__main__':
    main()
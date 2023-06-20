from datetime import datetime
import xml.etree.ElementTree as ET


def format(info):
    xml = ET.Element("datafile")

    info["metadata"]["size"] = str(info["metadata"]["size"])
    image = ET.SubElement(xml, "image", name=info["info"]["name"], **info["metadata"])

    info_element = ET.SubElement(image, "info")

    format_info(info_element, info["info"])

    contents = ET.SubElement(image, "contents")
    for file in info["contents"]:
        format_contents(contents, file)

    ET.indent(xml, level=0)
    return ET.tostring(xml, encoding="unicode")


def format_info(element, info):
    format_related(
        element, "system", info, {"system": "name", "system_identifier": "identifier"}
    )
    format_related(
        element,
        "header",
        info,
        {
            "header_title": "title",
            "header_product_number": "product_number",
            "header_product_version": "product_version",
            "header_release_date": "release_date",
            "header_maker_id": "maker_id",
            "header_device_info": "device_info",
            "header_regions": "regions",
        },
    )
    format_related(
        element,
        "volume",
        info,
        {
            "volume_identifier": "identifier",
            "volume_set_identifier": "set_identifier",
            "volume_creation_date": "creation_date",
            "volume_modification_date": "modification_date",
            "volume_expiration_date": "expiration_date",
            "volume_effective_date": "effective_date",
        },
    )
    format_related(
        element, "exe", info, {"exe_filename": "filename", "exe_date": "date"}
    )
    format_related(element, "disc", info, {"disc_type": "type"})


def format_related(element, name, info, key_map):
    output = {}
    for key, mapped in key_map.items():
        if value := info[key]:
            if isinstance(value, datetime):
                value = value.strftime("%Y-%m-%d %H:%M:%S")
            output[mapped] = value
    if output:
        return ET.SubElement(element, name, **output)


def format_contents(element, file):
    if file.get("type", "file") == "dir":
        props = {"name": file["name"], "date": file["date"], "size": file["size"]}

        dir = ET.SubElement(element, "directory", props)
        for file in file["files"]:
            format_contents(dir, file)
    else:
        ET.SubElement(element, "file", **file)

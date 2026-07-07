#!/usr/bin/env python3
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).parent
STAMP = (2024, 1, 1, 0, 0, 0)

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>
"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>
"""

COMMENTS_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
</Relationships>
"""

DOC_PREFIX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
"""

DOC_SUFFIX = """
    <w:sectPr/>
  </w:body>
</w:document>
"""

COMMENTS_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="0" w:author="Fixture" w:date="2024-01-01T00:00:00Z">
    <w:p><w:r><w:t>Review this sentence.</w:t></w:r></w:p>
  </w:comment>
</w:comments>
"""


def write_zip(path: Path, parts: dict[str, str]) -> None:
    with ZipFile(path, "w", compression=ZIP_DEFLATED) as archive:
        for name in sorted(parts):
            info = ZipInfo(name, STAMP)
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, parts[name].encode("utf-8"))


def docx(path: str, body: str, comments: bool = False) -> None:
    parts = {
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": RELS,
        "word/_rels/document.xml.rels": COMMENTS_RELS if comments else DOC_RELS,
        "word/document.xml": DOC_PREFIX + body + DOC_SUFFIX,
    }
    if comments:
        parts["word/comments.xml"] = COMMENTS_XML
    write_zip(ROOT / path, parts)


docx(
    "clean.docx",
    """    <w:p><w:r><w:t>Clean fixture document.</w:t></w:r></w:p>
""",
)

docx(
    "tracked-changes.docx",
    """    <w:p>
      <w:r><w:t>The contract is </w:t></w:r>
      <w:del w:id="1" w:author="Fixture" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>void</w:delText></w:r></w:del>
      <w:ins w:id="2" w:author="Fixture" w:date="2024-01-01T00:00:00Z"><w:r><w:t>valid</w:t></w:r></w:ins>
      <w:r><w:t>.</w:t></w:r>
    </w:p>
""",
)

docx(
    "comments.docx",
    """    <w:p>
      <w:r><w:t>Commented fixture document.</w:t></w:r>
      <w:commentRangeStart w:id="0"/>
      <w:r><w:t> Review point.</w:t></w:r>
      <w:commentRangeEnd w:id="0"/>
      <w:r><w:commentReference w:id="0"/></w:r>
    </w:p>
""",
    comments=True,
)

(ROOT / "not-a-zip.docx").write_bytes(b"not a zip docx fixture\n")

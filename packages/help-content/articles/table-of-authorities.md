---
id: table-of-authorities
title: Table of Authorities
group: legal
summary: Scan a brief for cited authorities, review the list, then save or prepend a Table of Authorities.
order: 19
---

# Table of Authorities

**Experimental feature:** Enable Experimental features in Settings before using Table of Authorities.

Build a Table of Authorities from the PDF you already have open. RaioPDF scans
the document text, groups the citations, and lets you fix the list before it
makes a table.

## Why you'd use it

Briefs often need a table that lists cases, statutes, rules, and constitutional
provisions with the pages where they appear. This tool gives you a first pass
from the document text, then keeps you in control of the final list.

## How to do it

1. Open the brief or motion.
2. Choose **Table of Authorities** from the **Legal** tools, or click **ToA** in
   the top bar.
3. Review each group. Turn off anything that is not a real authority.
4. Edit citation text if the table should use a different form.
5. Merge duplicate rows that refer to the same authority.
6. Use **Add authority** for anything the scan missed.
7. Set the **Passim threshold** if you want heavily cited authorities to show
   as passim.
8. Click **Save as PDF**, or **Prepend to current PDF** to put the table at the
   front of the open document.

## What to know

- **Page lists cover full citations only.** Short-form references — *id.*,
  *supra*, or a short cite like "410 U.S. at 116" — aren't counted, so an
  authority's page list misses the pages where your brief uses those forms.
  Review each authority and add the missing pages in the review step before
  you rely on the table.
- **You make the final call.** Detection is assistive. Review the table before
  you file or serve it.
- **Clean searchable text matters.** If the hidden text looks garbled, RaioPDF
  asks you to redo searchable text before scanning citations.
- **It stays on your computer.** The scan and table rendering run locally.
  Nothing is uploaded.
- **Prepend needs a standard open PDF.** Very large streamed documents need the
  table saved separately first.

## Related

- [Case Caption](tool:case-caption) - add a caption page before a filing
- [Prepare for Filing](tool:prepare-for-filing) - check the finished PDF before upload

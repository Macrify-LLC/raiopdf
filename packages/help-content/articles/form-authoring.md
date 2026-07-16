---
id: form-authoring
title: Create Fillable Fields
group: edit
summary: Turn a fieldless form into a reusable PDF with real text fields and checkboxes.
order: 21
---

# Create Fillable Fields

Add real fillable fields to a static or scanned form, then save a reusable PDF.
The fields remain interactive when the PDF is reopened in RaioPDF or another
ordinary PDF viewer.

## How to do it

1. Open the PDF and choose **Create Fillable Text Field** or **Create Fillable
   Checkbox** under **Edit**. The same tools are available in the page toolbar.
2. Click where the field should begin. RaioPDF places a pending field on the page.
3. Type an initial value in a text field, or select a checkbox if it should start
   checked.
4. Drag the field to move it. Select it and use the corner handles to resize it.
5. While the field is selected, change its name or mark it **Required** or
   **Read-only**. Text fields also offer font size and **Multiline** controls.
6. Choose **Save** or **Save As**. The field and its value are written together.

## Fill anywhere or create fillable fields?

- Use [Text Box](tool:textBox) to fill one static form quickly. It saves visible
  text as a PDF annotation.
- Use **Create Fillable Text Field** or **Create Fillable Checkbox** when the PDF
  should remain fillable and reusable after you save it.

## What to know

- **Field names must be unique.** RaioPDF supplies a name when you place a field.
  You can change it while the field is selected.
- **Nothing is written until you save.** Move, resize, fill, or remove pending
  fields before committing them to the PDF.
- **Signed and XFA forms are not rewritten.** RaioPDF stops and explains the
  limitation instead of changing those documents.
- **Large streamed documents are not supported yet.** Use an ordinary locally
  opened PDF for field authoring.
- **Prepare for Filing can flatten fields later.** Flattening locks their current
  appearance into the page and removes their fillable controls.

## Related

- [Text Box](tool:textBox) — fill anywhere without creating a reusable field
- [Prepare for Filing](tool:prepare-for-filing) — review and optionally flatten fields

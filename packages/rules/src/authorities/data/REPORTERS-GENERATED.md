# Generated Reporter Data

`reporters.generated.json` is a minimized slice of Free Law Project
`reporters-db` at commit `bcae37078404302fe452d6c0d111845777af95b1`, fetched from:

- `https://raw.githubusercontent.com/freelawproject/reporters-db/bcae37078404302fe452d6c0d111845777af95b1/reporters_db/data/reporters.json`

The generated slice keeps only Table of Authorities lookup data:

- lookup abbreviation keys, including reporter keys, edition keys, and reporter variation keys
- canonical reporter abbreviation
- reporter full name
- `kind: "case"`
- edition abbreviation lists

The generated file intentionally drops reporters-db examples, regexes, date ranges, notes,
links, publisher metadata, MLZ jurisdiction metadata, and cite-type nuance beyond the local
`kind: "case"` classification.

License check recorded 2026-07-10: reporters-db is BSD-2-Clause and GPL-3.0-compatible for
this GPL-3.0 repository. See `docs/ENGINE-VENDORING.md` for the audited provenance record.

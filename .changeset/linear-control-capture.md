---
'@nestvexa/client': patch
---

Morphs that contain many unnamed, unkeyed form controls now run in linear
time, for example a table with a selection checkbox in every row. Each
control's position used to be computed with a scan of its siblings, so
5,000 rows took minutes.

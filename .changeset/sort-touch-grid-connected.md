---
'@nestvexa/client': minor
---

`nv:sort` supports touch and pen gestures (Pointer Events on handles, `touch-action: none` set through the CSSOM), grids and wrapping layouts (geometry-based row detection, right-to-left aware, Alt+Arrow keys move by cell and row) and connected lists: `nv:sort.group="key"` links same-action lists of a component, which exchange items by drag, empty-list drop or Alt+Shift+Left/Right and send `{ item, lists }` proposals. Unconnected lists still send `{ ids }`.

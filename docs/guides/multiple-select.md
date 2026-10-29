# Multiple-select model arrays

An owned native `<select multiple>` can bind a top-level writable Live array. Its empty selection is `[]`. Without a cast, selected option values are strings; `.number` and `.boolean` convert each option using the same strict conversion rules as scalar models. Deferred/live/blur/change/lazy timing and the component request queue still apply. This is model binding, not the complete forms package.

```ts
@State({
  writable: true,
  validate: (value) =>
    Array.isArray(value) && value.length <= 3 &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === 'string' &&
      ['design', 'build', 'review'].includes(item)),
})
interests = ['design'];
```

```html
<label for="interests">Interests</label>
<select id="interests" multiple size="3" nv:model.change="interests">
  <option value="design" selected>Design</option>
  <option value="build">Build</option>
  <option value="review">Review</option>
</select>
```

The component and host must also register and authorize `$sync`/actions and supply identity, CSRF and origin policies; see [default Live setup](default-live-setup.md). The [runnable starter](../../examples/starter-live/src/main.ts) compiles the validator and renders server defaults from current state. Do not use `selected="false"`: a present boolean attribute is still true. Disabled options are not an authorization boundary.

## Shape, bounds and catalogs

Model arrays are unique, dense, flat primitive values. Nested arrays/objects, sparse or augmented arrays, accessor entries, nonfinite numbers and duplicate values reject. Numeric negative zero normalizes to zero because JSON cannot distinguish them. Bounds are **256 selected/state items**, **1,024 options per select**, and **16,384 UTF-8 bytes of serialized array JSON**, including punctuation and string escapes. Every individual option must fit that byte bound even when unselected. No general array or deep-object setter is added: `client.set()` and Alpine `$live.set()` remain primitive-only and reject writes that cannot describe an active array field without replacing its valid draft. `client.get()` returns a detached array.

Every option is validated before projection, including disabled and unselected options. Coerced values must be unique across the catalog: numeric `01`/`1`, boolean `true`/`1`, and numeric `-0`/`0` collide. Empty numeric options and ambiguous boolean values reject. An option using `nv:text` must declare an explicit `value` so changing its label cannot change identity after validation. Ordinary static labels may omit `value` and follow native option-value rules.

Reads use selected native options in DOM order, including disabled selected options. This differs deliberately from native form-data omission rules: it describes selected model state, so server validation and resource permissions must independently recheck every item. The [HTML select contract](https://html.spec.whatwg.org/multipage/form-elements.html#the-select-element) defines native selectedness; Nestvexa's bounds, coercion and projection are additional policies. A hostile browser can bypass every client bound. Generic server JSON limits are broader; applications need matching count, item type, allowlist, tenant and ownership validation. The example validator rejects forged, nested, duplicate and excessive selections.

## State, aliases and responses

Initial server state and response state project into selected properties by value membership. Projection does not rewrite default-selected attributes, dispatch input events or reorder the state array. A later native read uses the current DOM order; merely reordering options is not an implicit edit. Ordered structural equality prevents equivalent arrays from appearing dirty or causing redundant synchronization.

Multiple controls sharing the field must all be multiple selects with the same cast. Their catalogs and option order can differ: each displays the intersection with the shared array. Mixing scalar controls or casts rejects before projection. Unbound and ignored controls retain their existing rules. Aliases are shared state rather than independent form drafts.

A newer local edit survives an earlier response while an original compatible control remains. If its selected value disappears, the array keeps that unavailable value for server validation while the DOM displays available members; no silent normalization or substitute option is chosen. An actual subsequent edit reads the remaining options. Explicit replacement, field/cast change or multiple-to-single transition clears stale drafts when no compatible original control survives. Invalid response array shapes/catalogs reject before morphing or advancing revision and follow the [suspended transport policy](request-lifecycle.md).

Native reset reads actual selected defaults into a new field version, cancels model timers and sends no automatic request. Array aliases require the same ordered native default values; conflicting defaults cancel reset. Empty default selection is valid. Shared multiple-select aliases are projected to the reset field value even across separate forms; this changes live selectedness, not the other form's defaults. Canceled reset preserves drafts. See [native reset](form-reset.md).

## Verification and limits

[Reader/copy/projection tests](../../tests/client-models.test.ts) cover limits, Unicode, strict casts, getters and wire identity. [Controlled Chromium lifecycle cases](../../tests/client-form-reset.test.ts) cover dirty equality, aliases, responses, invalid catalogs, reset and atomic primitive setter rejection; controlled transport does not prove server conformance. [Real Nest scenarios](../../tests/browser/multiple-select.spec.ts) cover the actual synchronization/action endpoints, pending edits, reset, malformed selections and independent sessions. Executed results are recorded in [implementation status](../implementation/STATUS.md).

Checkbox selection groups, file models/uploads, nested field paths, nullable/scalar-array coercion, generic programmatic array setters and the complete forms/accessibility/platform matrix remain unmet. Private data must not be placed into public state or option markup.

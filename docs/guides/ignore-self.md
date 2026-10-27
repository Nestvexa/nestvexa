# Wrapper attribute ownership with `nv:ignore.self`

Use `nv:ignore.self=""` when a trusted widget owns a wrapper's attributes while Live owns its children. A retained wrapper keeps its current attributes, including widget-managed classes, style, ARIA values and IDs. Its children continue to receive server HTML and ordinary Live bindings, actions, model updates, loading effects and references.

```hbs
<section
  data-nv-key='editor-shell'
  id='editor-shell'
  nv:ignore.self=''
  class='widget-closed'
  aria-label='Editor'
>
  <label for='editor-name'>Display name</label>
  <input id='editor-name' nv:model='name' value='{{name}}' />
  <button type='button' nv:click='save'>Save</button>
  <span role='status' nv:loading='' nv:target='save'>Saving…</span>
  <p nv:text='saved'>{{saved}}</p>
</section>
```

This example needs explicitly registered writable `name` state and an authorized `save` action; see the [counter bootstrap](../../examples/live-counter/README.md). If the widget adds an open class or changes the shell's ARIA state, an ordinary Live response retains those attributes while updating the children. A stable `data-nv-key` lets the wrapper remain identifiable even when the widget changes its `id`. IDs must still satisfy normal HTML uniqueness and form-association rules.

## Ownership and configuration

`nv:ignore=""` preserves an entire subtree. `.self` preserves only the wrapper's attributes, so it does not transfer the children to a widget or framework renderer. Put a child widget that owns its own DOM inside a separate whole `nv:ignore` boundary. Existing whole-ignore nodes, nested Live roots and islands retain their ordinary boundaries when they appear below the wrapper.

The retained wrapper's `nv:*` configuration is fixed. Changing, adding or removing one of its directive declarations in a response fails preflight before the owned HTML is patched. To change that configuration, give the wrapper a new key or explicitly replace an ancestor. Reordering the same declarations does not change their configuration. Ordinary non-directive attributes in incoming markup do not overwrite retained wrapper attributes.

Same-node event, text and reference directives can remain active within their existing contracts. Put effects that write attributes or model state on children: `nv:bind`, `nv:show`, `nv:dirty`, `nv:cloak`, `nv:model`, loading/target directives and replacement directives cannot share the self-owned wrapper. Their modifiers are covered by the same restriction. This prevents competing owners from writing the wrapper's attributes.

The supported placement is an inner, non-editable wrapper. The client explicitly rejects `.self` on:

- A Live component root or an island root.
- `input`, `textarea`, `select`, `option` or `optgroup` elements.
- An editable wrapper or a wrapper inside editable content.
- A node also declaring whole `nv:ignore`, a nonempty ignore value, or an unknown ignore modifier.

Use whole `nv:ignore` for a native control or editor whose DOM belongs to an external widget. A self-owned wrapper does not satisfy the [Alpine adapter](../../packages/alpine/README.md)'s `$live` isolation requirement: that adapter still requires a whole-ignore subtree. `.self` does not establish arbitrary React/Vue/Svelte ownership or framework island support.

A standalone `contenteditable="false"` wrapper is supported. It cannot escape a surrounding editable owner's subtree: self-ignore below an editable ancestor is rejected even when the wrapper itself declares `contenteditable="false"`.

## Reconciliation and form owners

Before preview validation and control-state reconciliation, the client matches retained nodes and projects their self-owned attributes into an isolated incoming tree. Validation therefore sees the attributes and directive configuration that will actually remain in the document. Native radio reconciliation also sees retained form IDs rather than assuming that the raw response's IDs were applied. This is relevant when a stable keyed form wrapper retains its browser-managed ID.

Children still follow the [native control merge rules](native-controls.md). A changed server default can replace an unbound child edit; compatible newer model drafts can survive a pending response. File selection preservation does not provide uploads, and multiple-select models remain unsupported. Shared native radio groups across independent owners are still not an isolation boundary.

## Transitions and cleanup

Changing an ordinary wrapper to `.self`, or `.self` to an ordinary wrapper, replaces the element. Changing `.self` to a whole-ignore, nested Live or island boundary also transfers ownership by replacement. Removed children lose their local state and pending client resources, and normal removal/insertion notifications run. An explicitly replaced ancestor can remove a self-owned wrapper as well.

An existing whole-ignore node remains opaque during ordinary parent reconciliation, including an incoming request to make it self-owned or ordinary. Change its key or replace an ancestor to end that whole-subtree ownership. A same-key compatible `.self` wrapper with unchanged directives stays the same object during ordinary updates and keyed moves.

Removal cancels scheduled event/model work and releases nested client ownership; aborting a request does not undo effects already committed on the server. A rejected response may also follow an action that already ran. Reconcile trusted authoritative state instead of automatically retrying a mutation.

## Security and evidence

Attribute ownership is a browser lifecycle rule. It does not authorize actions, protect confidential state, sanitize arbitrary HTML or make widget code untrusted-safe. Templates and installed widget code remain trusted application code. The server must independently enforce identity, tenant ownership, CSRF/origin checks, input validation, writable-state rules and revisions. Hidden, disabled and ARIA attributes do not replace those checks.

The implementation is in [morph](../../packages/client/src/morph.ts) and the [client](../../packages/client/src/index.ts). The [real Nest browser scenarios](../../tests/browser/ignore-self.spec.ts) exercise retained wrapper attributes, escaped models, pending child edits/loading and ownership transitions. The [sample](../../examples/live-counter/README.md) includes the wrapper and its child controls. Consult the [implementation status](../implementation/STATUS.md) for executed results; file presence does not accept the full browser, accessibility, nested-server or renderer matrix.

# nv:upload

Upload the files chosen in an owned file input through `@nestvexa/uploads`, then store the resulting temporary tokens in a writable state field:

```hbs
<input type='file' nv:upload='image' />
<progress nv:upload.progress='image' value='0' max='1'></progress>
<p role='status' nv:upload.status='image'></p>
<button type='button' nv:upload.cancel='image'>Cancel</button>
```

## Syntax and modifiers

The value is a state field identifier, never a URL, purpose or action. An element takes exactly one upload declaration.

| Declaration                  | Element                                        | Behavior                                                                             |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `nv:upload="files"`          | `<input type="file">`, one per field, no model | On `change`, upload every selected file, then set `files` to the comma-joined tokens |
| `nv:upload.progress="files"` | `<progress>`                                   | `max` is the total bytes, `value` the bytes sent                                     |
| `nv:upload.status="files"`   | text-only element                              | "Uploading 40%", "Uploaded 2 files", "Upload cancelled" or "Upload failed: …"        |
| `nv:upload.cancel="files"`   | `<button type="button">`                       | Abort the active upload, or discard completed unfinalized tokens and clear the field |

Uploads are a lazily loaded client feature and need the trusted option `createLiveClient({ uploads: { endpoint: '/_nestvexa/uploads' } })`; a component using `nv:upload` without it is rejected. The token value is set as a local draft and travels with the next action, like an `nv:model` edit. The programmatic API is `client.upload(input)` and `client.cancelUpload(element)`; the input dispatches `nestvexa:upload` and `nestvexa:upload-error` events.

## Server contract

Import the uploads module and declare a policy for the purpose `<component-name>.<field>`; markup cannot choose another purpose. The field must be writable with a shape validator, `@State({ writable: true, validate: uploadReferenceField({ max: 5 }) })`. That validator only checks token syntax: the action must call `uploads.finalize(request, token, { purpose })`, which re-resolves identity, purpose, expiry, size, hash and content checks and spends the token. The transfer routes enforce identity, CSRF header, Origin, quotas and byte limits while streaming. See the [uploads guide](../guides/uploads.md).

## Security

A token is a temporary, single-use reference bound to the uploading identity and purpose; holding one does not let another user finalize it. Never trust the client's file name or type: finalization re-reads the stored bytes. Direct S3 purposes receive a presigned `PUT`, and the CSRF header is never sent to storage.

## Accessibility and fallback

Give the input a label and point `aria-describedby` at the status element, which should carry `role="status"`. While uploading the input has `aria-busy="true"`; on failure `aria-invalid="true"`. Without JavaScript the directive does nothing: provide a `multipart/form-data` form handled by `uploads.receiveForm`, or say that uploading needs JavaScript ([no-JavaScript fallback](../guides/uploads.md#3-no-javascript-fallback)).

## Example

<!-- snippet: examples/integration-matrix/views/product-table.hbs -->

```html
<input
  id="product-image"
  type="file"
  accept=".png,.jpg,.jpeg"
  aria-describedby="product-image-status"
  nv:upload="image"
/>
<progress
  id="product-image-progress"
  aria-label="Image upload progress"
  value="0"
  max="1"
  nv:upload.progress="image"
></progress>
<p
  id="product-image-status"
  role="status"
  aria-live="polite"
  nv:upload.status="image"
></p>
```

<!-- snippet: examples/integration-matrix/src/products.ts -->

```ts
  @State({ writable: true, validate: uploadReferenceField({ max: 1 }) })
  image = '';
```

<!-- snippet: examples/integration-matrix/src/products.ts -->

```ts
image = await this.uploads.finalize(this.request, token, {
  purpose: 'product-table.image',
});
```

## Verification

[Upload client tests](../../tests/client-upload.test.ts) (grammar, element rules, resumable chunks, retries, cancellation, events, ARIA state), the [grammar matrix](../../tests/client-directive-grammar.test.ts), [server upload tests](../../tests/uploads-http.test.ts) and the real-server [uploads browser scenarios](../../tests/browser/uploads.spec.ts) and [integration matrix](../../tests/browser/integration-matrix.spec.ts).

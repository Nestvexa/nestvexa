---
'@nestvexa/vite': minor
---

Subresource Integrity: `integrity: true | 'sha256' | 'sha384' | 'sha512'` on a
`ViteAssets` app hashes the built scripts, stylesheets and preloads when the manifest is
read and renders `integrity` plus `crossorigin` on their tags. Adds
`subresourceIntegrity` and `verifySubresourceIntegrity`.

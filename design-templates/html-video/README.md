# html-video templates

Render templates for the Open Design **HTML → Video** capability
(`od html-video generate --template <id>`). Each template is a folder:

```
<id>/
  template.json   # metadata + slot ("inputs") definitions
  index.html      # a HyperFrames single-composition body with {{slot}} placeholders
```

These are **not** design-template SKILL folders — the `html-video/` container
has no `SKILL.md`, so the design-templates skill scanner skips it. The
`apps/daemon/src/html-video/templates.ts` loader owns this subtree.

At render time the loader substitutes `{{slot}}` placeholders (text slots are
HTML-escaped; `color` slots are validated as CSS colors), wraps the result in a
throwaway HyperFrames composition, and renders it to MP4 via the local
HyperFrames engine. `{{duration}}`, `{{width}}`, and `{{height}}` resolve from
`template.json`.

## License

The templates in this directory are original works, licensed under
**Apache-2.0** (same as the repository). They contain no third-party assets.
When adding a template that reuses upstream assets, record the asset source and
its SPDX license in the template's `template.json` under an `assets` key and
confirm redistribution is permitted.

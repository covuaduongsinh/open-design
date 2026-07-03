// HTML → Video template catalogue.
//
// M1 ships an empty catalogue: the capability renders agent-scaffolded
// HyperFrames compositions directly. The license-clean template library
// (21 curated templates vendored under `design-templates/html-video/`) and
// intent search land in M2, at which point this module reads their
// `template.*.yaml` metadata. The shape is fixed by the contract
// (`HtmlVideoTemplateSummary`) so the CLI and web UI can render a picker
// before the library exists.

import type { HtmlVideoTemplateSummary } from '@open-design/contracts';

/**
 * List available html-video templates. Empty until the library lands (M2).
 * `search` is accepted now so the CLI/web surface is stable; it currently
 * has nothing to rank.
 */
export function listHtmlVideoTemplates(_search?: string): HtmlVideoTemplateSummary[] {
  return [];
}

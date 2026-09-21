import Mustache from "mustache";

/**
 * A host's page with the rendered parts laid in, as Mustache: `{{key}}`
 * escaped for HTML text and for an attribute value in either quote,
 * `{{{key}}}` raw. The view is data only, and no partials are given, so
 * a template reaches nothing beyond the view.
 */
export function fill(template: string, view: unknown): string {
  return Mustache.render(template, view);
}

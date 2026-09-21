/**
 * report-problem/2.0 (didcomm.org): a peer's report about something
 * this vault sent. It is read beside the outbound its thread names and
 * answered with nothing: a report about a report is how two agents
 * talk past each other for good.
 */

import type { JsonObject } from "@estoc/event-store";
import { PROBLEM_REPORT_TYPE } from "@estoc/vault";

import type { Handler } from "./handler.js";

export const reportProblem: Handler = {
  types: [PROBLEM_REPORT_TYPE],
  effectTypes: [],
  respond: async () => [],
};

/** What a report's body says, for display beside the outbound it is about: its code, then its comment with each `{n}` replaced by the n-th argument, or by `?` where none is given. */
export function reportedProblem(body: JsonObject): string {
  const code = typeof body.code === "string" && body.code !== "" ? body.code : "unknown";
  if (typeof body.comment !== "string" || body.comment === "") return code;
  const args = Array.isArray(body.args) ? body.args : [];
  const comment = body.comment.replace(/\{(\d+)\}/g, (_, n: string) => {
    const arg = args[Number(n) - 1];
    return typeof arg === "string" ? arg : "?";
  });
  return `${code}: ${comment}`;
}

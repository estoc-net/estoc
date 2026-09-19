/**
 * report-problem/2.0 (didcomm.org): a peer's report about something
 * this vault sent. It is read beside the outbound its thread names and
 * answered with nothing: a report about a report is how two agents
 * talk past each other for good.
 */

import { PROBLEM_REPORT_TYPE } from "@estoc/vault/v3";

import type { Handler } from "./handler.js";

export const reportProblem: Handler = {
  types: [PROBLEM_REPORT_TYPE],
  effectTypes: [],
  respond: async () => [],
};

export { RetrievalService } from "./service.js";
export {
  BAGGAGE_FACETS,
  buildFtsQuery,
  detectFacet,
  detectPrivacyAspects,
  detectRouteScopeHints,
  isComparisonQuery,
  isLikelyAirlineName,
  makeAirlineAliases,
  matchAirlines,
  normalizeForSearch,
} from "./query-routing.js";

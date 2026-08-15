// bench/concept.js
// Thin re-export of the shared parser in ../concept-core.js.
//
// This file used to hold its own copy of the logic. That made the bench score a
// parser the extension did not run: the NLI selector's accuracy is a direct
// function of how `concept` is extracted, so two copies meant two different
// systems being measured. The logic now lives in one place, imported by both
// the bench and the service worker.

module.exports = require('../concept-core.js');

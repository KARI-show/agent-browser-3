// Content script of the "elements" extra: the build copies it to extras-elements.cs.js in builds of brands that
// have the feature, and the feature's panel module registers it with chrome.scripting
// .registerContentScripts (id "extras-elements", http/https pages, document_start, persistAcrossSessions)
// so the edits saved for a site come back on every load, panel open or not. Classic script, ISOLATED
// world: chrome.storage.local and the DOM only, nothing from the panel.
(function () {
})();

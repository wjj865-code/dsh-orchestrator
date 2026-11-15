(function() {
  "use strict";
  const CLIENT_ID = "@wjj865-code/dsh-orchestrator";
  window.__ModuleLoader__.load({
    id: CLIENT_ID,
    factory: (req) => {
      const inject = ["slots", "layout", "uiWorkspace"];
      const apply = (ctx) => {
      };
      return { inject, apply };
    }
  });
})();
//# sourceMappingURL=client.js.map

// Run from the installed Electron-as-Node runtime. Shipped DSH peer modules
// resolve from the running installation rather than an unrelated checkout.
const { registerHooks, createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const anchor = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || (!specifier.startsWith('@deepseek-ai/') && specifier !== 'fflate')) throw error;
      return nextResolve(pathToFileURL(anchor.resolve(specifier)).href, context);
    }
  },
});

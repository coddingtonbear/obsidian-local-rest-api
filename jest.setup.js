// Obsidian plugins use window.setTimeout etc. in plugin code.
// In the Node test environment there is no window object, so alias the global.
global.window = global;
global.activeWindow = global;

// Obsidian exposes moment on the window object; periodic-notes code uses window.moment().
global.moment = require("moment");

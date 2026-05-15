// Obsidian plugins use activeWindow.setTimeout etc. for popout-window compatibility.
// In the Node test environment there is no window object, so alias the global.
global.activeWindow = global;

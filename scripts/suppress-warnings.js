#!/usr/bin/env node

// Suppress baseline-browser-mapping warnings
const originalConsoleWarn = console.warn;
console.warn = function (...args) {
  const message = args.join(" ");
  if (message.includes("baseline-browser-mapping")) {
    return; // Suppress these warnings
  }
  originalConsoleWarn.apply(console, args);
};

// Suppress rollup warnings about unresolved dependencies for Node.js built-ins
const originalConsoleLog = console.log;
console.log = function (...args) {
  const message = args.join(" ");
  if (
    message.includes("Unresolved dependencies") ||
    message.includes("async_hooks") ||
    message.includes("node:console") ||
    message.includes("node:util")
  ) {
    return; // Suppress these warnings
  }
  originalConsoleLog.apply(console, args);
};

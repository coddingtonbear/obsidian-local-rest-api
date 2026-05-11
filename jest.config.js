module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^src/(.*)": "<rootDir>/src/$1",
    obsidian: "<rootDir>/mocks/obsidian.ts",
    // Marked is ESM-only; point Jest at the UMD build so CommonJS transforms work.
    "^marked$": "<rootDir>/node_modules/marked/lib/marked.umd.js",
    // McpHandler imports the MCP SDK which bundles ESM-only zod internals that
    // jest (CommonJS) can't load. Since no tests exercise MCP, mock it entirely.
    "^.+/mcpHandler$": "<rootDir>/mocks/mcpHandler.ts",
  },
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.test.json",
      diagnostics: false,
    },
  },
  transform: {
    "\\.ts$": ["ts-jest"],
    "\\.ya?ml$": "jest-raw-loader",
  },
};

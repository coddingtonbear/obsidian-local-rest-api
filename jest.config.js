module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/jest.setup.js"],
  testPathIgnorePatterns: ["/node_modules/", "/src/integration/"],
  moduleNameMapper: {
    "^src/(.*)": "<rootDir>/src/$1",
    "^obsidian$": "<rootDir>/mocks/obsidian.ts",
    // Marked is ESM-only; point Jest at the UMD build so CommonJS transforms work.
    "^marked$": "<rootDir>/node_modules/marked/lib/marked.umd.js",
    // Jest 27 doesn't support package.json exports maps, so deep .js paths in the
    // MCP SDK (e.g. @modelcontextprotocol/sdk/server/mcp.js) must be resolved
    // explicitly to the CJS dist. Tests that load McpHandler mock the SDK classes
    // directly so the ESM-only zod internals bundled with the SDK are never touched.
    "^@modelcontextprotocol/sdk/(.+)\\.js$":
      "<rootDir>/node_modules/@modelcontextprotocol/sdk/dist/cjs/$1.js",
  },
  transform: {
    "\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json", diagnostics: false }],
    "\\.ya?ml$": "<rootDir>/jest-raw-transformer.js",
  },
};

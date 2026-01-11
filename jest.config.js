module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^src/(.*)": "<rootDir>/src/$1",
    obsidian: "<rootDir>/mocks/obsidian.ts",
    // Marked is ESM-only; point Jest at the UMD build so CommonJS transforms work.
    "^marked$": "<rootDir>/node_modules/marked/lib/marked.umd.js",
  },
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.test.json",
    },
  },
  transform: {
    "\\.ts$": ["ts-jest"],
    "\\.ya?ml$": "jest-raw-loader",
  },
};

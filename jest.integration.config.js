module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  transform: {
    "\\.ts$": ["ts-jest", { tsconfig: "tsconfig.integration.json", diagnostics: false }],
  },
  testMatch: ["**/src/integration/**/*.test.ts"],
  testTimeout: 30000,
};

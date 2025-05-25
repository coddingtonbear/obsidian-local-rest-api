module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^src/(.*)": "<rootDir>/src/$1",
    obsidian: "<rootDir>/mocks/obsidian.ts",
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

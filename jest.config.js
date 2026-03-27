/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  modulePaths: ["<rootDir>"],
  moduleDirectories: ["node_modules", "<rootDir>/node_modules"],
  resolver: "<rootDir>/jest.resolver.js",
  transform: {
    "^.+\\.(ts|js|mjs)$": ["@swc/jest"],
  },
  transformIgnorePatterns: [
    "node_modules/(?!(@actions|@octokit|undici|universal-user-agent|before-after-hook|deprecation)/)",
  ],
  collectCoverage: true,
  coverageProvider: "v8",
  collectCoverageFrom: ["src/**/*.ts", "!src/index.ts"],
  coverageDirectory: "test/.coverage",
  coverageReporters: ["text", "cobertura", "json-summary", "json"],
  coveragePathIgnorePatterns: ["/node_modules/"],
  reporters: ["default", "github-actions", "jest-junit"],
  verbose: true,
}
